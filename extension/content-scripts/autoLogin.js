/**
 * autoLogin.js — Auto-login content script for Lactalis portal
 *
 * Runs on all mylactalis.com.au pages. When it detects a login page,
 * it reads stored credentials from chrome.storage.local and auto-submits
 * the login form. This keeps the session alive for the always-on relay.
 *
 * Credentials are stored locally on the machine only (never sent to Worker).
 */
;(function () {
  'use strict'

  const DEBUG = false
  const LOG = '[Milk Manager Auto-Login]'

  // Only act on login pages
  if (!isLoginPage()) return

  if (DEBUG) console.log(`${LOG} Login page detected — checking for stored credentials`)

  chrome.storage.local.get(['lactalisUsername', 'lactalisPassword', 'autoLoginEnabled'], async (result) => {
    if (!result.autoLoginEnabled) {
      if (DEBUG) console.log(`${LOG} Auto-login disabled`)
      return
    }
    if (!result.lactalisUsername || !result.lactalisPassword) {
      if (DEBUG) console.log(`${LOG} No credentials stored`)
      return
    }

    // Wait for form to be ready
    const form = await waitForLoginForm(5000)
    if (!form) {
      console.warn(`${LOG} Login form not found within timeout`)
      return
    }

    console.log(`${LOG} Auto-logging in as ${result.lactalisUsername}…`)
    fillAndSubmitLogin(form, result.lactalisUsername, result.lactalisPassword)
  })

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function isLoginPage() {
    const url = location.href.toLowerCase()
    const path = location.pathname.toLowerCase()
    return (
      url.includes('/login') ||
      url.includes('/signin') ||
      path.includes('/customer/user/login') ||
      !!document.querySelector('form[action*="login"]') ||
      !!document.querySelector('#loginForm') ||
      !!document.querySelector('input[name="_username"]')
    )
  }

  function waitForLoginForm(timeoutMs) {
    return new Promise((resolve) => {
      // Try immediately
      const form = findLoginForm()
      if (form) return resolve(form)

      // Poll for it
      const start = Date.now()
      const interval = setInterval(() => {
        const f = findLoginForm()
        if (f) {
          clearInterval(interval)
          resolve(f)
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval)
          resolve(null)
        }
      }, 300)
    })
  }

  function findLoginForm() {
    // OroCommerce login form patterns
    const selectors = [
      'form[action*="login"]',
      'form[action*="signin"]',
      '#loginForm',
      'form[name="login"]',
      'form[id*="login"]',
    ]
    for (const sel of selectors) {
      const f = document.querySelector(sel)
      if (f) return f
    }

    // Fallback: find a form with username + password inputs
    for (const form of document.querySelectorAll('form')) {
      const hasUser = form.querySelector('input[name="_username"], input[name="username"], input[name="email"], input[type="email"]')
      const hasPass = form.querySelector('input[name="_password"], input[name="password"], input[type="password"]')
      if (hasUser && hasPass) return form
    }

    return null
  }

  function fillAndSubmitLogin(form, username, password) {
    // Find username input
    const userInput = form.querySelector(
      'input[name="_username"], input[name="username"], input[name="email"], input[type="email"]'
    )
    // Find password input
    const passInput = form.querySelector(
      'input[name="_password"], input[name="password"], input[type="password"]'
    )

    if (!userInput || !passInput) {
      console.warn(`${LOG} Could not find username/password inputs in form`)
      return
    }

    // Fill fields (handle React/framework controlled inputs)
    setInputValue(userInput, username)
    setInputValue(passInput, password)

    // Small delay then submit
    setTimeout(() => {
      // Try clicking a submit button first (more reliable than form.submit())
      const submitBtn = form.querySelector(
        'button[type="submit"], input[type="submit"], button[name="login"], button:not([type="button"])'
      )
      if (submitBtn) {
        submitBtn.click()
        console.log(`${LOG} Clicked submit button`)
      } else {
        form.submit()
        console.log(`${LOG} Submitted form directly`)
      }

      // Notify background that we auto-logged in
      chrome.runtime.sendMessage({
        type: 'AUTO_LOGIN_ATTEMPTED',
        username,
        timestamp: Date.now(),
      })
    }, 500)
  }

  // NOTE: Intentionally duplicated — content scripts cannot share JS modules.
  // Mirror any changes to: quickOrder.js, autoLogin.js, public/fill-order.js
  function setInputValue(el, value) {
    // Try native setter for React-controlled inputs
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement?.prototype
      : window.HTMLInputElement?.prototype
    const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (nativeSet) {
      nativeSet.call(el, value)
    } else {
      el.value = value
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
})()
