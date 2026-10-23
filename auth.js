// auth.js - Master ERP Shield & Session Gate
const ERP_AUTH_API = "https://script.google.com/macros/s/AKfycbzxWfNcv_JE9e5h3B43_QeSWveOkC5Ie5m1MTpwyGZ4_ZQeFD1CVYLXW3vW-JozEuGS/exec";

(function checkERPAuthentication() {
  const isAuth = sessionStorage.getItem("erp_auth_active");
  if (isAuth === "true") return; // Session valid

  // Inject sleek login modal
  window.addEventListener("DOMContentLoaded", function() {
    const overlay = document.createElement("div");
    overlay.id = "authGuardOverlay";
    overlay.style.cssText = "position:fixed; inset:0; background:rgba(15,23,42,0.92); backdrop-filter:blur(12px); z-index:999999; display:flex; align-items:center; justify-content:center; font-family:'Plus Jakarta Sans',sans-serif;";

    overlay.innerHTML = `
      <div style="background:#ffffff; width:90%; max-width:400px; padding:32px; border-radius:24px; box-shadow:0 25px 50px rgba(0,0,0,0.25); text-align:center;">
        <div style="font-size:36px; margin-bottom:8px;">🔐</div>
        <h2 style="font-size:20px; font-weight:800; color:#1e1b4b; margin-bottom:6px;">Harsidhi ERP Security Gate</h2>
        <p style="font-size:12.5px; color:#64748b; margin-bottom:20px;">Enter your master authorized password to access this console.</p>
        <input type="password" id="gatePassInput" placeholder="Master Password..." style="width:100%; padding:12px; border:2px solid #e2e8f0; border-radius:12px; font-size:14px; outline:none; text-align:center; margin-bottom:14px;" onkeypress="if(event.key==='Enter') executeGateLogin()" />
        <button id="gateLoginBtn" onclick="executeGateLogin()" style="width:100%; padding:12px; background:#1e1b4b; color:#fff; border:none; border-radius:30px; font-size:14px; font-weight:800; cursor:pointer;">Authorize & Open</button>
        <div id="gateError" style="font-size:12px; color:#ef4444; font-weight:700; margin-top:10px; display:none;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  });
})();

async function executeGateLogin() {
  const pass = document.getElementById("gatePassInput").value;
  const btn = document.getElementById("gateLoginBtn");
  const err = document.getElementById("gateError");
  if (!pass) return;

  btn.innerText = "Verifying...";
  btn.disabled = true;
  err.style.display = "none";

  try {
    const res = await fetch(ERP_AUTH_API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "verifyLogin", payload: { password: pass } })
    }).then(r => r.json());

    if (res.success) {
      sessionStorage.setItem("erp_auth_active", "true");
      const overlay = document.getElementById("authGuardOverlay");
      if (overlay) overlay.remove();
    } else {
      err.innerText = res.error || "Access Denied: Wrong Password";
      err.style.display = "block";
      btn.innerText = "Authorize & Open";
      btn.disabled = false;
    }
  } catch(e) {
    err.innerText = "Connection Error: " + e.message;
    err.style.display = "block";
    btn.innerText = "Authorize & Open";
    btn.disabled = false;
  }
}
