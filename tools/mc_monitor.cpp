/*
 * mc_monitor.cpp — Minecraft Server Live Ping Monitor
 *
 * Sends proper SLP (Server List Ping) packets, measures RTT, detects downtime,
 * and calls POST /api/bots/reconnect/all when the server recovers.
 *
 * Build (Linux/macOS):
 *   g++ -O2 -std=c++17 mc_monitor.cpp -o mc_monitor
 *
 * Build (Windows with MinGW):
 *   g++ -O2 -std=c++17 mc_monitor.cpp -o mc_monitor.exe -lws2_32
 *
 * Usage:
 *   ./mc_monitor [mc-host] [mc-port] [dashboard-url] [interval-sec]
 *   ./mc_monitor play.example.com 25565 http://localhost:3000 10
 */

#ifdef _WIN32
#  define _WIN32_WINNT 0x0601
#  include <winsock2.h>
#  include <ws2tcpip.h>
#  pragma comment(lib, "ws2_32.lib")
   using socklen_t = int;
#else
#  include <arpa/inet.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <sys/socket.h>
#  include <unistd.h>
#  define INVALID_SOCKET (-1)
#  define SOCKET_ERROR   (-1)
#  define closesocket    close
   using SOCKET = int;
#endif

#include <chrono>
#include <cstring>
#include <ctime>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ── VarInt helpers ────────────────────────────────────────────────────────────

static std::vector<uint8_t> encodeVarInt(int32_t value) {
    std::vector<uint8_t> out;
    uint32_t v = static_cast<uint32_t>(value);
    do {
        uint8_t byte = v & 0x7F;
        v >>= 7;
        if (v) byte |= 0x80;
        out.push_back(byte);
    } while (v);
    return out;
}

static void appendVarInt(std::vector<uint8_t>& buf, int32_t value) {
    auto vi = encodeVarInt(value);
    buf.insert(buf.end(), vi.begin(), vi.end());
}

static void appendString(std::vector<uint8_t>& buf, const std::string& s) {
    appendVarInt(buf, static_cast<int32_t>(s.size()));
    buf.insert(buf.end(), s.begin(), s.end());
}

static void appendUInt16BE(std::vector<uint8_t>& buf, uint16_t v) {
    buf.push_back((v >> 8) & 0xFF);
    buf.push_back(v & 0xFF);
}

static std::vector<uint8_t> wrapPacket(int32_t id, const std::vector<uint8_t>& data) {
    std::vector<uint8_t> payload;
    appendVarInt(payload, id);
    payload.insert(payload.end(), data.begin(), data.end());
    std::vector<uint8_t> out;
    appendVarInt(out, static_cast<int32_t>(payload.size()));
    out.insert(out.end(), payload.begin(), payload.end());
    return out;
}

// ── Socket helpers ────────────────────────────────────────────────────────────

static SOCKET connectTCP(const std::string& host, int port, int timeoutSec) {
    struct addrinfo hints{}, *res = nullptr;
    hints.ai_family   = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0)
        return INVALID_SOCKET;

    SOCKET s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCKET) { freeaddrinfo(res); return INVALID_SOCKET; }

#ifdef _WIN32
    DWORD tv = timeoutSec * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));
#else
    struct timeval tv{ timeoutSec, 0 };
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif

    if (connect(s, res->ai_addr, static_cast<socklen_t>(res->ai_addrlen)) != 0) {
        closesocket(s); freeaddrinfo(res); return INVALID_SOCKET;
    }
    freeaddrinfo(res);
    return s;
}

static bool sendAll(SOCKET s, const std::vector<uint8_t>& data) {
    size_t sent = 0;
    while (sent < data.size()) {
        int n = send(s, reinterpret_cast<const char*>(data.data() + sent),
                     static_cast<int>(data.size() - sent), 0);
        if (n <= 0) return false;
        sent += n;
    }
    return true;
}

static int recvByte(SOCKET s) {
    uint8_t b;
    int n = recv(s, reinterpret_cast<char*>(&b), 1, 0);
    if (n <= 0) return -1;
    return b;
}

static int32_t readVarInt(SOCKET s) {
    int32_t result = 0; int shift = 0;
    for (int i = 0; i < 5; ++i) {
        int b = recvByte(s); if (b < 0) return -1;
        result |= (b & 0x7F) << shift;
        if (!(b & 0x80)) return result;
        shift += 7;
    }
    return -1;
}

// ── HTTP POST (minimal, no libcurl) ──────────────────────────────────────────

static void httpPost(const std::string& url) {
    // Parse http://host[:port]/path
    std::string host, path = "/";
    int port = 80;
    std::string u = url;
    if (u.substr(0, 7) == "http://")  u = u.substr(7);
    auto slash = u.find('/');
    if (slash != std::string::npos) { path = u.substr(slash); u = u.substr(0, slash); }
    auto colon = u.find(':');
    if (colon != std::string::npos) { port = std::stoi(u.substr(colon+1)); host = u.substr(0, colon); }
    else host = u;

    SOCKET s = connectTCP(host, port, 5);
    if (s == INVALID_SOCKET) { std::cerr << "[HTTP] Could not connect to " << host << ":" << port << "\n"; return; }

    std::ostringstream req;
    req << "POST " << path << " HTTP/1.1\r\n"
        << "Host: " << host << "\r\n"
        << "Content-Type: application/json\r\n"
        << "Content-Length: 2\r\n"
        << "Connection: close\r\n\r\n{}";
    std::string rs = req.str();
    std::vector<uint8_t> rb(rs.begin(), rs.end());
    sendAll(s, rb);
    closesocket(s);
}

// ── SLP ping ─────────────────────────────────────────────────────────────────

struct PingResult { bool alive; long long rttMs; std::string motd; int online; int maxPlayers; };

static PingResult pingServer(const std::string& host, int port) {
    PingResult r{false, 0, "", 0, 0};
    auto t0 = std::chrono::steady_clock::now();
    SOCKET s = connectTCP(host, port, 5);
    if (s == INVALID_SOCKET) return r;

    // Handshake packet (state=1 for status)
    std::vector<uint8_t> hs;
    appendVarInt(hs, 47);          // protocol version
    appendString(hs, host);
    appendUInt16BE(hs, static_cast<uint16_t>(port));
    appendVarInt(hs, 1);           // next state: status
    auto hsPkt = wrapPacket(0x00, hs);

    // Status request (empty body)
    auto reqPkt = wrapPacket(0x00, {});

    if (!sendAll(s, hsPkt) || !sendAll(s, reqPkt)) { closesocket(s); return r; }

    // Read status response
    int32_t len = readVarInt(s); if (len <= 0) { closesocket(s); return r; }
    int32_t id  = readVarInt(s); if (id != 0x00) { closesocket(s); return r; }

    int32_t jsonLen = readVarInt(s); if (jsonLen <= 0) { closesocket(s); return r; }
    std::string json(jsonLen, '\0');
    int got = 0;
    while (got < jsonLen) {
        int n = recv(s, &json[got], jsonLen - got, 0);
        if (n <= 0) break;
        got += n;
    }
    closesocket(s);

    auto t1 = std::chrono::steady_clock::now();
    r.rttMs = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
    r.alive = (got == jsonLen);

    // Minimal JSON extraction (no dependencies)
    auto extract = [&](const std::string& key) -> std::string {
        auto pos = json.find("\"" + key + "\"");
        if (pos == std::string::npos) return "";
        pos = json.find(':', pos); if (pos == std::string::npos) return "";
        while (pos < json.size() && (json[++pos] == ' '));
        if (json[pos] == '"') {
            auto end = json.find('"', pos+1);
            return end != std::string::npos ? json.substr(pos+1, end-pos-1) : "";
        }
        auto end = json.find_first_of(",}", pos);
        return end != std::string::npos ? json.substr(pos, end-pos) : "";
    };

    r.online     = std::stoi(extract("online").empty() ? "0" : extract("online"));
    r.maxPlayers = std::stoi(extract("max").empty()    ? "0" : extract("max"));

    // Strip MOTD color codes (§X)
    auto descPos = json.find("\"text\"");
    if (descPos != std::string::npos) {
        auto q1 = json.find('"', descPos + 7);
        auto q2 = json.find('"', q1 + 1);
        if (q1 != std::string::npos && q2 != std::string::npos)
            r.motd = json.substr(q1+1, q2-q1-1);
    }
    // Remove §X sequences
    std::string clean;
    for (size_t i = 0; i < r.motd.size(); ++i) {
        if (r.motd[i] == '\xC2' && i+1 < r.motd.size() && r.motd[i+1] == '\xA7') { i += 2; continue; }
        if (r.motd[i] == '\xA7' && i+1 < r.motd.size()) { ++i; continue; }
        clean += r.motd[i];
    }
    r.motd = clean;
    return r;
}

// ── Logging ───────────────────────────────────────────────────────────────────

static std::string timestamp() {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    char buf[20];
    std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", std::localtime(&t));
    return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
#ifdef _WIN32
    WSADATA wsa; WSAStartup(MAKEWORD(2,2), &wsa);
#endif

    std::string mcHost      = argc > 1 ? argv[1] : "localhost";
    int         mcPort      = argc > 2 ? std::stoi(argv[2]) : 25565;
    std::string dashUrl     = argc > 3 ? argv[3] : "http://localhost:3000";
    int         intervalSec = argc > 4 ? std::stoi(argv[4]) : 10;

    std::string reconnectUrl = dashUrl + "/api/bots/reconnect/all";

    std::cout << "MC Monitor started\n"
              << "  Server   : " << mcHost << ":" << mcPort << "\n"
              << "  Dashboard: " << dashUrl << "\n"
              << "  Interval : " << intervalSec << "s\n\n";

    bool wasDown = false;
    int  downCount = 0;

    while (true) {
        auto r = pingServer(mcHost, mcPort);
        std::string ts = timestamp();

        if (r.alive) {
            std::cout << "[" << ts << "] \033[32mUP\033[0m  "
                      << r.rttMs << "ms  players=" << r.online << "/" << r.maxPlayers;
            if (!r.motd.empty()) std::cout << "  MOTD: " << r.motd;
            std::cout << "\n";

            if (wasDown) {
                std::cout << "[" << ts << "] Server recovered after " << downCount
                          << " failed pings — triggering reconnect\n";
                httpPost(reconnectUrl);
                downCount = 0;
            }
            wasDown = false;
        } else {
            ++downCount;
            std::cout << "[" << ts << "] \033[31mDOWN\033[0m  (streak=" << downCount << ")\n";
            wasDown = true;
        }

        std::this_thread::sleep_for(std::chrono::seconds(intervalSec));
    }

#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
