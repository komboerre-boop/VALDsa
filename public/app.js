function readThemeVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function readThemeNumber(name, fallback) {
  const value = Number.parseFloat(readThemeVar(name, ''))
  return Number.isFinite(value) ? value : fallback
}

function getParticleTheme() {
  return {
    count: Math.max(24, Math.round(readThemeNumber('--particle-count', 120))),
    particleRgb: readThemeVar('--particle-rgb', '126, 182, 255'),
    lineRgb: readThemeVar('--line-rgb', readThemeVar('--particle-rgb', '126, 182, 255')),
    speed: readThemeNumber('--particle-speed', 0.5),
    sizeMin: readThemeNumber('--particle-size-min', 1),
    sizeMax: readThemeNumber('--particle-size-max', 3),
    opacityMin: readThemeNumber('--particle-opacity-min', 0.2),
    opacityMax: readThemeNumber('--particle-opacity-max', 0.55),
    linkDistance: readThemeNumber('--particle-link-distance', 100),
    influence: readThemeNumber('--particle-influence', 0.01),
    influenceRadius: readThemeNumber('--particle-influence-radius', 100)
  }
}

// Custom Cursor
function initCustomCursor() {
  const cursor = document.querySelector('.custom-cursor')
  if (!cursor) return

  function updateInteractiveElements() {
    const interactiveElements = document.querySelectorAll('a, button, .btn, .toast-close, .toast-btn, input, textarea, select, label')

    interactiveElements.forEach(el => {
      if (el.dataset.cursorBound === '1') return
      el.dataset.cursorBound = '1'
      el.addEventListener('mouseenter', () => cursor.classList.add('hover'))
      el.addEventListener('mouseleave', () => cursor.classList.remove('hover'))
    })
  }

  if (!document.body.dataset.cursorTracking) {
    document.body.dataset.cursorTracking = '1'
    document.addEventListener('mousemove', e => {
      cursor.style.left = `${e.clientX}px`
      cursor.style.top = `${e.clientY}px`
    })
  }

  updateInteractiveElements()

  const observer = new MutationObserver(() => {
    updateInteractiveElements()
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true
  })
}

// Animated Particles Background
function initParticles() {
  const canvas = document.getElementById('particles-canvas')
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  const particles = []
  let theme = getParticleTheme()
  let mouseX = 0
  let mouseY = 0

  function resizeCanvas() {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
  }

  class Particle {
    constructor() {
      this.reset(true)
    }

    reset(initial = false) {
      this.x = Math.random() * canvas.width
      this.y = Math.random() * canvas.height
      if (!initial && Math.random() > 0.5) {
        this.x = Math.random() > 0.5 ? -10 : canvas.width + 10
      }
      const range = Math.max(theme.sizeMax - theme.sizeMin, 0.1)
      this.size = Math.random() * range + theme.sizeMin
      this.speedX = Math.random() * theme.speed - theme.speed / 2
      this.speedY = Math.random() * theme.speed - theme.speed / 2
      this.opacity = Math.random() * Math.max(theme.opacityMax - theme.opacityMin, 0.01) + theme.opacityMin
    }

    update() {
      this.x += this.speedX
      this.y += this.speedY

      if (this.x > canvas.width) this.x = 0
      if (this.x < 0) this.x = canvas.width
      if (this.y > canvas.height) this.y = 0
      if (this.y < 0) this.y = canvas.height
    }

    draw() {
      ctx.fillStyle = `rgba(${theme.particleRgb}, ${this.opacity})`
      ctx.beginPath()
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2)
      ctx.fill()
    }

    applyMouseInfluence() {
      const dx = mouseX - this.x
      const dy = mouseY - this.y
      const distance = Math.sqrt(dx * dx + dy * dy)

      if (distance < theme.influenceRadius) {
        this.x -= dx * theme.influence
        this.y -= dy * theme.influence
      }
    }
  }

  function syncParticles(reset = false) {
    if (reset) {
      particles.length = 0
    }

    while (particles.length < theme.count) {
      particles.push(new Particle())
    }

    if (particles.length > theme.count) {
      particles.length = theme.count
    }

    if (reset) {
      particles.forEach(particle => particle.reset(true))
    }
  }

  function updateTheme() {
    theme = getParticleTheme()
    syncParticles(true)
  }

  resizeCanvas()
  syncParticles()

  document.addEventListener('mousemove', e => {
    mouseX = e.clientX
    mouseY = e.clientY
  })

  function drawConnections() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[j].x - particles[i].x
        const dy = particles[j].y - particles[i].y
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (distance < theme.linkDistance) {
          ctx.strokeStyle = `rgba(${theme.lineRgb}, ${0.2 * (1 - distance / theme.linkDistance)})`
          ctx.lineWidth = 0.5
          ctx.beginPath()
          ctx.moveTo(particles[i].x, particles[i].y)
          ctx.lineTo(particles[j].x, particles[j].y)
          ctx.stroke()
        }
      }
    }
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    particles.forEach(particle => {
      particle.update()
      particle.draw()
      particle.applyMouseInfluence()
    })

    drawConnections()
    requestAnimationFrame(animate)
  }

  animate()

  window.addEventListener('resize', () => {
    resizeCanvas()
    syncParticles(true)
  })

  window.addEventListener('cake-theme-change', updateTheme)
}

// Button Effects
function initButtonEffects() {
  const buttons = document.querySelectorAll('.btn')

  buttons.forEach(button => {
    if (button.dataset.rippleBound === '1') return
    button.dataset.rippleBound = '1'

    button.addEventListener('click', e => {
      const ripple = document.createElement('span')
      const rect = button.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height)
      const x = e.clientX - rect.left - size / 2
      const y = e.clientY - rect.top - size / 2

      ripple.style.width = `${size}px`
      ripple.style.height = `${size}px`
      ripple.style.left = `${x}px`
      ripple.style.top = `${y}px`
      ripple.classList.add('ripple')

      button.appendChild(ripple)

      setTimeout(() => ripple.remove(), 600)
    })
  })
}

// Login Form
function initLoginForm() {
  const loginForm = document.getElementById('loginForm')
  if (!loginForm) return
  
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    
    const passwordInput = document.getElementById('password')
    let password = passwordInput?.value?.trim()
    
    if (!password) {
      Toast.error('Пожалуйста, введите пароль', 'Поле не заполнено')
      passwordInput.focus()
      return
    }
    
    password = sanitizeInput(password)
    
    if (password.length < 6) {
      Toast.error('Пароль должен содержать минимум 6 символов')
      return
    }
    
    if (password.length > 128) {
      Toast.error('Пароль слишком длинный')
      return
    }
    
    const submitBtn = loginForm.querySelector('button[type="submit"]')
    const originalText = submitBtn.textContent
    submitBtn.innerHTML = '<span class="spinner"></span> Проверка...'
    submitBtn.disabled = true
    
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      })
      
      const data = await response.json()
      
      if (data.success && data.token) {
        // Save session
        const session = {
          token: data.token,
          user: data.user || {},
          loginTime: new Date().toISOString()
        }
        localStorage.setItem('cakeworld_auth', JSON.stringify(session))
        
        Toast.success('Вход выполнен успешно!')
        
        // Redirect to panel
        setTimeout(() => {
          window.location.href = '/'
        }, 500)
      } else {
        Toast.error(data.message || 'Неверный пароль')
        passwordInput.value = ''
        passwordInput.focus()
      }
    } catch (error) {
      console.error('Login error:', error)
      
      if (error.message.includes('Failed to fetch')) {
        Toast.error('Запустите сервер командой: cd server && npm start', 'Сервер не запущен')
      } else {
        Toast.error('Не удалось подключиться к серверу', 'Ошибка сети')
      }
    } finally {
      submitBtn.textContent = originalText
      submitBtn.disabled = false
    }
  })
}

// Security utilities
function sanitizeInput(input) {
  if (typeof input !== 'string') return ''
  
  return input
    .trim()
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .slice(0, 128)
}

// Toast notification system
const Toast = {
  container: null,
  
  init() {
    if (!this.container) {
      this.container = document.createElement('div')
      this.container.className = 'toast-container'
      document.body.appendChild(this.container)
    }
  },
  
  show(message, type = 'info', title = '', duration = 5000) {
    this.init()
    
    const icons = {
      success: '✓',
      error: '✕',
      warning: '!',
      info: 'i'
    }
    
    const titles = {
      success: title || 'Успешно',
      error: title || 'Ошибка',
      warning: title || 'Внимание',
      info: title || 'Информация'
    }
    
    const toast = document.createElement('div')
    toast.className = `toast toast-${type}`
    
    const safeMessage = message.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const safeTitle = titles[type].replace(/</g, '&lt;').replace(/>/g, '&gt;')
    
    toast.innerHTML = `
      <div class="toast-icon">${icons[type]}</div>
      <div class="toast-content">
        <div class="toast-title">${safeTitle}</div>
        <div class="toast-message">${safeMessage}</div>
      </div>
      <button class="toast-close">×</button>
    `
    
    const closeBtn = toast.querySelector('.toast-close')
    closeBtn.addEventListener('click', () => this.remove(toast))
    
    this.container.appendChild(toast)
    
    if (duration > 0) {
      setTimeout(() => this.remove(toast), duration)
    }
    
    return toast
  },
  
  remove(toast) {
    toast.classList.add('toast-exit')
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast)
      }
    }, 300)
  },
  
  success(message, title) {
    return this.show(message, 'success', title, 3000)
  },
  
  error(message, title) {
    return this.show(message, 'error', title, 7000)
  },
  
  warning(message, title) {
    return this.show(message, 'warning', title)
  },
  
  info(message, title) {
    return this.show(message, 'info', title)
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initCustomCursor()
  initParticles()
  initButtonEffects()
  initLoginForm()
})
