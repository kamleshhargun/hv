// ===================================================================
// auth.js - Master ERP Shield & Session Token Gateway
// ===================================================================

const ERP_AUTH_API = "https://script.google.com/macros/s/AKfycbxN5691sn-Xd2JujwABkuoYxO8HoAlGccGobno19eXYOfO598SRKK4UJfgKTepFyxhz/exec"; // <-- Apne naye Code.gs ka Web App URL yahan daalein

// 1. Global Session Token Getter
window.getAuthToken = function() {
  return sessionStorage.getItem("erp_session_token") || "";
};

// 2. Immediate Security Guard
(function initAuthGuard() {
  const token = window.getAuthToken();
  if (token) return; // Session already authorized

  window.addEventListener("DOMContentLoaded", function() {
    const appBox = document.querySelector(".app-box") || document.querySelector(".container");
    if (appBox) appBox.style.display = "none";

    const overlay = document.createElement("div");
    overlay.id = "authGuardOverlay";
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(15,23,42,0.96); backdrop-filter:blur(16px); z-index:999999; display:flex; align-items:center; justify-content:center; font-family:'Plus Jakarta Sans',sans-serif;";

    overlay.innerHTML = `
      <div style="background:#ffffff; width:92%; max-width:400px; padding:32px; border-radius:24px; box-shadow:0 25px 50px rgba(0,0,0,0.35); text-align:center;">
        <div style="font-size:38px; margin-bottom:8px;">🔐</div>
        <h2 style="font-size:20px; font-weight:800; color:#1e1b4b; margin-bottom:6px;">Harsidhi ERP Security Gate</h2>
        <p style="font-size:12.5px; color:#64748b; margin-bottom:20px;">Master authorization password is required to generate session key.</p>
        <input type="password" id="gatePassInput" placeholder="Master Password..." style="width:100%; padding:12px; border:2px solid #e2e8f0; border-radius:12px; font-size:14px; outline:none; text-align:center; margin-bottom:14px;" onkeypress="if(event.key==='Enter') executeGateLogin()" />
        <button id="gateLoginBtn" onclick="executeGateLogin()" style="width:100%; padding:12px; background:#1e1b4b; color:#fff; border:none; border-radius:30px; font-size:14px; font-weight:800; cursor:pointer;">Unlock System</button>
        <div id="gateError" style="font-size:12px; color:#ef4444; font-weight:700; margin-top:10px; display:none;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  });
})();

// 3. Login Verification Function
async function executeGateLogin() {
  const passInput = document.getElementById("gatePassInput");
  const btn = document.getElementById("gateLoginBtn");
  const err = document.getElementById("gateError");
  if (!passInput) return;

  const pass = passInput.value.trim();
  if (!pass) return;

  btn.innerText = "Authenticating...";
  btn.disabled = true;
  err.style.display = "none";

  try {
    const res = await fetch(ERP_AUTH_API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "verifyLogin", payload: { password: pass } })
    }).then(r => r.json());

    if (res.success && res.token) {
      sessionStorage.setItem("erp_session_token", res.token);
      const overlay = document.getElementById("authGuardOverlay");
      if (overlay) overlay.remove();
      const appBox = document.querySelector(".app-box") || document.querySelector(".container");
      if (appBox) appBox.style.display = "block";
      location.reload(); // Reload to execute main page scripts with valid session
    } else {
      err.innerText = res.error || "Access Denied: Wrong Password";
      err.style.display = "block";
      btn.innerText = "Unlock System";
      btn.disabled = false;
    }
  } catch(e) {
    err.innerText = "Connection Error: " + e.message;
    err.style.display = "block";
    btn.innerText = "Unlock System";
    btn.disabled = false;
  }
}
