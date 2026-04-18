/*
 * 1.cpp -- Minecraft Server Monitor Agent
 *
 * Pings MC server every N seconds via SLP protocol.
 * POSTs status JSON to bot dashboard -> shown as live widget in UI.
 *
 * Build (Windows MinGW):
 *   g++ -O2 -std=c++17 tools\1.cpp -o tools\1.exe -lws2_32
 *
 * Build (Linux/macOS):
 *   g++ -O2 -std=c++17 tools/1.cpp -o tools/1
 *
 * Usage:
 *   1.exe <mc-host> <mc-port> <dashboard-url> [interval-sec]
 *   1.exe play.example.com 25565 http://localhost:3000 10
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
#  define closesocket close
   using SOCKET = int;
#endif

#include <chrono>
#include <cstring>
#include <ctime>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ── VarInt ───────────────────────────────────────────────────────────────────
static void appendVI(std::vector<uint8_t>& b, int32_t v) {
    uint32_t u = static_cast<uint32_t>(v);
    do { uint8_t x = u & 0x7F; u >>= 7; if (u) x |= 0x80; b.push_back(x); } while (u);
}
static void appendStr(std::vector<uint8_t>& b, const std::string& s) {
    appendVI(b, static_cast<int32_t>(s.size()));
    b.insert(b.end(), s.begin(), s.end());
}
static void appendU16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back((v >> 8) & 0xFF); b.push_back(v & 0xFF);
}
static std::vector<uint8_t> packet(int32_t id, std::vector<uint8_t> data) {
    std::vector<uint8_t> pl; appendVI(pl, id);
    pl.insert(pl.end(), data.begin(), data.end());
    std::vector<uint8_t> out; appendVI(out, static_cast<int32_t>(pl.size()));
    out.insert(out.end(), pl.begin(), pl.end()); return out;
}

// ── TCP ──────────────────────────────────────────────────────────────────────
static SOCKET tcpConnect(const std::string& host, int port, int tSec) {
    struct addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0)
        return INVALID_SOCKET;
    SOCKET s = socket(res->ai_family, res->ai_socktype, 0);
    if (s == INVALID_SOCKET) { freeaddrinfo(res); return INVALID_SOCKET; }
#ifdef _WIN32
    DWORD tv = tSec * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));
#else
    struct timeval tv{tSec,0};
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
    if (connect(s, res->ai_addr, static_cast<socklen_t>(res->ai_addrlen)) != 0) {
        closesocket(s); freeaddrinfo(res); return INVALID_SOCKET;
    }
    freeaddrinfo(res); return s;
}
static bool sendAll(SOCKET s, const std::vector<uint8_t>& d) {
    size_t n = 0;
    while (n < d.size()) {
        int r = send(s, reinterpret_cast<const char*>(d.data()+n), (int)(d.size()-n), 0);
        if (r <= 0) return false; n += r;
    }
    return true;
}
static int readVI(SOCKET s) {
    int r=0, sh=0;
    for (int i=0;i<5;i++) { uint8_t b; if(recv(s,(char*)&b,1,0)<=0)return -1;
        r|=(b&0x7F)<<sh; if(!(b&0x80))return r; sh+=7; }
    return -1;
}

// ── SLP ping ─────────────────────────────────────────────────────────────────
struct MC { bool online; long long rtt; int players; int maxPlayers; std::string motd; };

static MC ping(const std::string& host, int port) {
    MC r{false,0,0,0,""};
    auto t0 = std::chrono::steady_clock::now();
    SOCKET s = tcpConnect(host, port, 5);
    if (s == INVALID_SOCKET) return r;

    std::vector<uint8_t> hs;
    appendVI(hs,47); appendStr(hs,host); appendU16(hs,(uint16_t)port); appendVI(hs,1);
    auto hsPkt = packet(0x00, hs);
    auto rqPkt = packet(0x00, {});
    if (!sendAll(s, hsPkt) || !sendAll(s, rqPkt)) { closesocket(s); return r; }

    int len = readVI(s); if (len<=0) { closesocket(s); return r; }
    if (readVI(s) != 0x00) { closesocket(s); return r; }
    int jlen = readVI(s); if (jlen<=0) { closesocket(s); return r; }
    std::string json(jlen,'\0');
    int got=0; while(got<jlen){ int n=recv(s,&json[got],jlen-got,0); if(n<=0)break; got+=n; }
    closesocket(s);

    auto t1 = std::chrono::steady_clock::now();
    r.rtt = std::chrono::duration_cast<std::chrono::milliseconds>(t1-t0).count();
    r.online = (got==jlen);

    auto num = [&](const std::string& key) -> int {
        auto p = json.find("\""+key+"\""); if(p==std::string::npos)return 0;
        p = json.find(':',p); if(p==std::string::npos)return 0;
        while(p<json.size()&&json[++p]==' ');
        auto e = json.find_first_of(",}",p);
        try { return std::stoi(json.substr(p, e-p)); } catch(...){return 0;}
    };
    r.players    = num("online");
    r.maxPlayers = num("max");

    auto tp = json.find("\"text\"");
    if (tp!=std::string::npos) {
        auto q1=json.find('"',tp+7), q2=json.find('"',q1+1);
        if(q1!=std::string::npos&&q2!=std::string::npos) r.motd=json.substr(q1+1,q2-q1-1);
    }
    // strip colour codes
    std::string clean; for(size_t i=0;i<r.motd.size();i++){
        if(r.motd[i]=='\xC2'&&i+1<r.motd.size()&&r.motd[i+1]=='\xA7'){i+=2;continue;}
        if(r.motd[i]=='\xA7'&&i+1<r.motd.size()){i++;continue;} clean+=r.motd[i]; }
    r.motd=clean;
    return r;
}

// ── HTTP POST (no libcurl) ────────────────────────────────────────────────────
static void httpPost(const std::string& url, const std::string& body) {
    std::string u = url, host, path="/"; int port=80;
    if(u.substr(0,7)=="http://") u=u.substr(7);
    auto sl=u.find('/'); if(sl!=std::string::npos){path=u.substr(sl);u=u.substr(0,sl);}
    auto co=u.find(':'); if(co!=std::string::npos){port=std::stoi(u.substr(co+1));host=u.substr(0,co);}else host=u;
    SOCKET s = tcpConnect(host, port, 5);
    if (s == INVALID_SOCKET) return;
    std::ostringstream req;
    req<<"POST "<<path<<" HTTP/1.1\r\nHost: "<<host<<"\r\n"
       <<"Content-Type: application/json\r\nContent-Length: "<<body.size()
       <<"\r\nConnection: close\r\n\r\n"<<body;
    std::string rs=req.str();
    std::vector<uint8_t> rb(rs.begin(),rs.end());
    sendAll(s,rb); closesocket(s);
}

// ── JSON escape ───────────────────────────────────────────────────────────────
static std::string jesc(const std::string& s) {
    std::string r; for(char c:s) {
        if(c=='"') r+="\\\""; else if(c=='\\') r+="\\\\"; else r+=c; }
    return r;
}

// ── Timestamp ─────────────────────────────────────────────────────────────────
static std::string ts() {
    auto t=std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    char b[20]; std::strftime(b,sizeof(b),"%H:%M:%S",std::localtime(&t)); return b;
}

// ── Main ──────────────────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
#ifdef _WIN32
    WSADATA w; WSAStartup(MAKEWORD(2,2),&w);
#endif
    if (argc < 4) {
        std::cerr << "Usage: 1.exe <mc-host> <mc-port> <dashboard-url> [interval-sec]\n"
                  << "  e.g: 1.exe play.example.com 25565 http://localhost:3000 10\n";
        return 1;
    }
    std::string mcHost    = argv[1];
    int         mcPort    = std::stoi(argv[2]);
    std::string dashUrl   = argv[3];
    int         interval  = argc>4 ? std::stoi(argv[4]) : 10;
    std::string statusUrl = dashUrl + "/api/mc-status";

    std::cout << "[MC Monitor] " << mcHost << ":" << mcPort
              << " -> " << dashUrl << " every " << interval << "s\n";

    int downStreak = 0;

    while (true) {
        auto r = ping(mcHost, mcPort);
        std::string color = r.online ? "\033[32m" : "\033[31m";
        std::cout << "[" << ts() << "] " << color
                  << (r.online?"UP  ":"DOWN")
                  << "\033[0m";
        if (r.online)
            std::cout << " " << r.rtt << "ms  "
                      << r.players << "/" << r.maxPlayers << " players";
        else
            std::cout << " (streak=" << ++downStreak << ")";
        if (!r.motd.empty()) std::cout << "  " << r.motd;
        std::cout << "\n";

        if (r.online) downStreak = 0;

        // POST to dashboard
        std::ostringstream j;
        j << "{"
          << "\"online\":"   << (r.online?"true":"false") << ","
          << "\"rtt\":"      << r.rtt << ","
          << "\"players\":"  << r.players << ","
          << "\"max\":"      << r.maxPlayers << ","
          << "\"motd\":\""   << jesc(r.motd) << "\","
          << "\"downStreak\":" << downStreak
          << "}";
        try { httpPost(statusUrl, j.str()); } catch(...) {}

        std::this_thread::sleep_for(std::chrono::seconds(interval));
    }
#ifdef _WIN32
    WSACleanup();
#endif
}
