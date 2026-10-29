// <-- APPS SCRIPT WEB APP URL (Replace with your deployed Web App URL) -->
const API_URL = "https://script.google.com/macros/s/AKfycbzwZxkVDPuRc37kOqrC-dZ3dH-qr7gC-wL1c2lSnckyMRTJWqaEZ_RkRRiWWlr1j1qc/exec";

// <-- SUPABASE CONFIGURATION -->
const SUPABASE_URL = "https://bkmynjioyjtzzjtwloee.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJrbXluamlveWp0enpqdHdsb2VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNDI5MzIsImV4cCI6MjEwNzgxODkzMn0.L34UB_G55TSP9EAW9Xox-obUUe8XsVIwDTJ8XwfQ85A";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let authenticatedPin = "";
let dashboardData = {};
let activeTab = "all_orders";
let currentActionMode = "pickup";
let html5QrCode = null;
let pendingAwbData = null;

let currentPage = 1;
let pageSize = 50;
let reconSortAsc = false;

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playBeep(success) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(success ? 880 : 220, ctx.currentTime);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

function onPinInput(el, idx) {
  const inputs = document.querySelectorAll(".pin-digit");
  if (el.value.length === 1 && idx < 3) inputs[idx + 1].focus();
  let pin = "";
  inputs.forEach(i => pin += i.value);
  if (pin.length === 4) verifyFastPin(pin);
}

function verifyFastPin(pin) {
  fetch(`${API_URL}?action=verifyPin&pin=${encodeURIComponent(pin)}`)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        authenticatedPin = pin;
        document.getElementById("lockScreen").style.display = "none";
        document.getElementById("appScreen").style.display = "block";
        loadDashboard();
      } else {
        showPinError();
      }
    })
    .catch(() => showPinError());
}

function showPinError() {
  document.getElementById("pinError").style.display = "block";
  const inputs = document.querySelectorAll(".pin-digit");
  inputs.forEach(i => i.value = "");
  inputs[0].focus();
}

async function fetchAllSupabaseRows() {
  let allRecords = [];
  let from = 0;
  let limit = 1000;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await sb
      .from('dispatches_master')
      .select('*')
      .range(from, from + limit - 1)
      .order('date', { ascending: false });

    if (error || !data) break;
    allRecords = allRecords.concat(data);
    if (data.length < limit) hasMore = false;
    else from += limit;
  }
  return allRecords;
}

async function loadDashboard() {
  document.getElementById("ordersContainer").innerHTML = '<div style="text-align:center; padding:35px; color:var(--muted);">Synchronizing realtime Supabase records...</div>';

  try {
    const [supabaseOrders, carrierRes] = await Promise.all([
      fetchAllSupabaseRows(),
      fetch(`${API_URL}?pin=${authenticatedPin}&action=getLiveCarriersData`).then(r => r.json()).catch(() => ({ success: false }))
    ]);

    const boxdOrders = (carrierRes.success && carrierRes.boxd_orders) ? carrierRes.boxd_orders : [];
    const skuMap = (carrierRes.success && carrierRes.sku_map) ? carrierRes.sku_map : {};

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yest.toISOString().slice(0, 10);
    const monthPrefix = todayStr.slice(0, 7);

    const pickedUpMap = {};
    const dateWiseRecon = {};
    let kpis = {
      today: { count: 0, amount: 0, gs: 0, uc: 0 },
      yesterday: { count: 0, amount: 0, gs: 0, uc: 0 },
      month: { count: 0, amount: 0, gs: 0, uc: 0 }
    };

    const pastOrdersToTrack = [];

    const dbOrders = supabaseOrders.map(row => {
      const scanDateStr = String(row.date || "").slice(0, 10);
      const awbVal = String(row.awb_number || "").trim();
      const whTag = String(row.warehouse_tag || "OTHER").toUpperCase();
      const rowAmt = parseFloat(row.total_amount || 0);
      const payStatus = String(row.payment_status || "PENDING").trim();
      let currentStage = String(row.current_stage || "PICKED").trim();

      // STRICT RULE: Agar aaj ki date me scan hua hai, toh woh PICKED tab me hi rahega
      if (scanDateStr === todayStr) {
        currentStage = "PICKED";
      } else if (currentStage === "PICKED") {
        // Kal ya usse purane orders automatic In-Transit shift honge
        currentStage = "IN_TRANSIT";
        pastOrdersToTrack.push(awbVal);
      }

      if (awbVal) {
        pickedUpMap[awbVal] = { stage: currentStage, scanDate: scanDateStr };
      }

      if (scanDateStr) {
        if (!dateWiseRecon[scanDateStr]) {
          dateWiseRecon[scanDateStr] = { date: scanDateStr, count: 0, total_amount: 0, received_amount: 0, pending_count: 0 };
        }
        dateWiseRecon[scanDateStr].count++;
        dateWiseRecon[scanDateStr].total_amount += rowAmt;
        if (payStatus === "RECEIVED") {
          dateWiseRecon[scanDateStr].received_amount += parseFloat(row.payment_received_amount || rowAmt);
        } else {
          dateWiseRecon[scanDateStr].pending_count++;
        }

        if (scanDateStr === todayStr) {
          kpis.today.count++;
          kpis.today.amount += rowAmt;
          if (whTag === "GS") kpis.today.gs++;
          else if (whTag === "UC") kpis.today.uc++;
        }
        if (scanDateStr === yesterdayStr) {
          kpis.yesterday.count++;
          kpis.yesterday.amount += rowAmt;
          if (whTag === "GS") kpis.yesterday.gs++;
          else if (whTag === "UC") kpis.yesterday.uc++;
        }
        if (scanDateStr.startsWith(monthPrefix)) {
          kpis.month.count++;
          kpis.month.amount += rowAmt;
          if (whTag === "GS") kpis.month.gs++;
          else if (whTag === "UC") kpis.month.uc++;
        }
      }

      return {
        date: scanDateStr,
        awb_number: awbVal,
        customer_order_number: row.customer_order_number || "-",
        order_number: row.order_number || "-",
        warehouse_tag: whTag,
        customer_name: row.customer_name || "-",
        phone: row.phone || "",
        city: row.city || "",
        state: row.state || "",
        payment_mode: row.payment_mode || "PREPAID",
        total_amount: rowAmt,
        products_summary: row.products_summary || "",
        payment_status: payStatus,
        payment_received_amount: parseFloat(row.payment_received_amount || 0),
        payment_received_date: row.payment_received_date || "",
        gateway: row.gateway || "",
        tx_id: row.tx_id || "",
        packed_status: row.packed_status || "PICKED_UP",
        current_stage: currentStage,
        live_status: currentStage
      };
    });

    // Background tracking sync for past orders (Non-blocking)
    if (pastOrdersToTrack.length > 0) {
      fetch(`${API_URL}?pin=${authenticatedPin}&action=batchTrackStatuses&awbs=${encodeURIComponent(pastOrdersToTrack.slice(0, 25).join(','))}`)
        .then(r => r.json())
        .then(res => {
          if (res.success && res.statuses) {
            for (let awb in res.statuses) {
              const matched = dbOrders.find(o => o.awb_number === awb);
              if (matched && matched.current_stage !== res.statuses[awb]) {
                matched.current_stage = res.statuses[awb];
                sb.from('dispatches_master').update({ current_stage: res.statuses[awb] }).eq('awb_number', awb).then();
              }
            }
          }
        }).catch(() => {});
    }

    const allOrders = [];
    const pickupFailed = [];

    boxdOrders.forEach(o => {
      const awbVal = String(o.awb_number || (o.shipment ? o.shipment.awb : "") || "").trim();
      if (!awbVal || awbVal === "null" || awbVal === "undefined") return;

      const rawStatus = String(o.status || "").toLowerCase().trim();
      if (rawStatus === "cancelled" || rawStatus === "delivered" || rawStatus === "rto_delivered") {
        if (!pickedUpMap[awbVal]) return;
      }

      const orderDateRaw = o.created_at || o.shipped_date || "";
      const isFailed = rawStatus.includes("fail") || rawStatus.includes("pickup_error");
      const isNewManifested = rawStatus.includes("manifest") || rawStatus.includes("ready") || rawStatus.includes("label") || rawStatus === "shipped" || rawStatus === "new";

      let cohort = "";
      if (isFailed) cohort = "pickup_failed";
      else if (isNewManifested) cohort = "today_new";
      else if (pickedUpMap[awbVal]) cohort = "picked_up";
      else return;

      const cust = o.customer || o.shipping_address || {};
      const prods = o.products || o.order_items || [];
      const prodStr = prods.map(p => `${p.sku || p.name} (Qty: ${p.quantity || 1})`).join(", ");

      let whTag = "OTHER";
      const lowerSummary = prodStr.toLowerCase();
      for (let sku in skuMap) {
        if (lowerSummary.includes(sku)) { whTag = skuMap[sku]; break; }
      }
      if (whTag === "OTHER") {
        const combined = ((o.store_name || "") + " " + (o.channel_name || "")).toLowerCase();
        if (combined.includes("gulabi") || combined.includes("gs")) whTag = "GS";
        else if (combined.includes("uncluttered") || combined.includes("uc")) whTag = "UC";
      }

      const isPickedUp = !!pickedUpMap[awbVal];
      const orderObj = {
        date: String(orderDateRaw).slice(0, 10),
        awb_number: awbVal,
        customer_order_number: o.customer_order_number || o.channel_order_id || o.order_number || "-",
        order_number: o.order_number || String(o.id || "-"),
        warehouse_tag: whTag,
        store_name: o.store_name || "",
        customer_name: o.shipping_name || cust.name || o.customer_name || "-",
        phone: o.shipping_phone_number || cust.phone || "-",
        city: o.shipping_city || cust.city || "-",
        state: o.shipping_state || cust.state || "",
        payment_mode: o.payment_mode || (o.is_cod ? "COD" : "PREPAID"),
        total_amount: parseFloat(o.total_amount || 0),
        products_summary: prodStr,
        status: o.status || "new",
        cohort: cohort,
        is_picked_up: isPickedUp
      };

      if (!isPickedUp) {
        allOrders.push(orderObj);
        if (cohort === "pickup_failed") pickupFailed.push(orderObj);
      }
    });

    const reconList = Object.values(dateWiseRecon).sort((a, b) => b.date.localeCompare(a.date));

    dashboardData = {
      kpis: kpis,
      date_wise_recon: reconList,
      all_orders: allOrders,
      pickup_failed: pickupFailed,
      picked: dbOrders.filter(o => o.current_stage === "PICKED" && o.date === todayStr),
      intransit: dbOrders.filter(o => o.current_stage === "IN_TRANSIT"),
      out_for_delivery: dbOrders.filter(o => o.current_stage === "OUT_FOR_DELIVERY"),
      delivered: dbOrders.filter(o => o.current_stage === "DELIVERED"),
      rto: dbOrders.filter(o => o.current_stage === "RTO"),
      rto_received: dbOrders.filter(o => o.current_stage === "RTO_RECEIVED"),
      pending_payment: dbOrders.filter(o => o.payment_status === "PENDING"),
      payment_received: dbOrders.filter(o => o.payment_status === "RECEIVED")
    };

    renderKpis();
    renderCounts();
    currentPage = 1;
    renderActiveTab();
  } catch (err) {
    document.getElementById("ordersContainer").innerHTML = `<div style="text-align:center; padding:35px; color:var(--jelly-red);">Sync Failed: ${err.message}</div>`;
  }
}

function renderKpis() {
  if (!dashboardData.kpis) return;
  const k = dashboardData.kpis;
  document.getElementById("kpiTodayCount").innerText = k.today.count;
  document.getElementById("kpiTodayAmt").innerText = "₹" + k.today.amount.toLocaleString('en-IN');
  document.getElementById("kpiTodayGs").innerText = "GS: " + k.today.gs;
  document.getElementById("kpiTodayUc").innerText = "UC: " + k.today.uc;

  document.getElementById("kpiYestCount").innerText = k.yesterday.count;
  document.getElementById("kpiYestAmt").innerText = "₹" + k.yesterday.amount.toLocaleString('en-IN');
  document.getElementById("kpiYestGs").innerText = "GS: " + k.yesterday.gs;
  document.getElementById("kpiYestUc").innerText = "UC: " + k.yesterday.uc;

  document.getElementById("kpiMonthCount").innerText = k.month.count;
  document.getElementById("kpiMonthAmt").innerText = "₹" + k.month.amount.toLocaleString('en-IN');
  document.getElementById("kpiMonthGs").innerText = "GS: " + k.month.gs;
  document.getElementById("kpiMonthUc").innerText = "UC: " + k.month.uc;
}

function renderCounts() {
  const tabs = ['all_orders', 'pickup_failed', 'picked', 'intransit', 'out_for_delivery', 'delivered', 'rto', 'rto_received', 'pending_payment', 'payment_received'];
  tabs.forEach(t => {
    const count = (dashboardData[t] || []).length;
    const el = document.getElementById("c_" + t);
    if (el) el.innerText = count;
  });
  const reconCount = (dashboardData.date_wise_recon || []).length;
  document.getElementById("c_daily_recon").innerText = reconCount;
}

function switchTab(tab) {
  activeTab = tab;
  currentPage = 1;
  document.querySelectorAll(".tab-pill").forEach(b => b.classList.remove("active"));
  const btn = document.getElementById("tab_" + tab);
  if (btn) btn.classList.add("active");
  renderActiveTab();
}

function toggleReconSort() {
  reconSortAsc = !reconSortAsc;
  renderActiveTab();
}

function changePageSize(val) {
  pageSize = parseInt(val) || 50;
  currentPage = 1;
  renderActiveTab();
}

function prevPage() {
  if (currentPage > 1) {
    currentPage--;
    renderActiveTab();
    window.scrollTo({ top: 300, behavior: 'smooth' });
  }
}

function nextPage() {
  const fullList = getActiveTabList();
  const totalPages = Math.ceil(fullList.length / pageSize) || 1;
  if (currentPage < totalPages) {
    currentPage++;
    renderActiveTab();
    window.scrollTo({ top: 300, behavior: 'smooth' });
  }
}

function getActiveTabList() {
  if (activeTab === "daily_recon") return dashboardData.date_wise_recon || [];
  return dashboardData[activeTab] || [];
}

function renderActiveTab() {
  const container = document.getElementById("ordersContainer");
  const paginationBar = document.getElementById("paginationBar");

  if (activeTab === "daily_recon") {
    paginationBar.style.display = "none";
    let list = [...(dashboardData.date_wise_recon || [])];
    if (list.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:35px; color:var(--muted);">No reconciliation records generated yet.</div>`;
      return;
    }

    list.sort((a, b) => reconSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
    const sortArrow = reconSortAsc ? "▲ Ascending" : "▼ Descending";

    let html = `
      <div class="recon-table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th class="sortable" onclick="toggleReconSort()">Dispatch Date ${sortArrow}</th>
              <th>Total Packets</th>
              <th>Total Value</th>
              <th>Payment Collected</th>
              <th>Pending Count</th>
            </tr>
          </thead>
          <tbody>
    `;
    list.forEach((r, idx) => {
      html += `
        <tr>
          <td style="color:var(--muted);">${idx + 1}</td>
          <td><b>📅 ${r.date}</b></td>
          <td>${r.count} pkts</td>
          <td style="font-weight:800;">₹${r.total_amount.toLocaleString('en-IN')}</td>
          <td style="color:var(--jelly-green); font-weight:800;">₹${r.received_amount.toLocaleString('en-IN')}</td>
          <td style="color:${r.pending_count > 0 ? '#b45309' : '#047857'}; font-weight:800;">${r.pending_count} pending</td>
        </tr>
      `;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
    return;
  }

  paginationBar.style.display = "flex";
  const fullList = dashboardData[activeTab] || [];

  if (fullList.length === 0) {
    paginationBar.style.display = "none";
    container.innerHTML = `<div style="text-align:center; padding:35px; color:var(--muted);">No records available in this queue.</div>`;
    return;
  }

  const totalItems = fullList.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  if (currentPage > totalPages) currentPage = totalPages;

  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const pageItems = fullList.slice(startIndex, endIndex);

  document.getElementById("pageDisplayInfo").innerText = `Showing ${startIndex + 1}–${endIndex} of ${totalItems} (Page ${currentPage} of ${totalPages})`;
  document.getElementById("btnPrevPage").disabled = (currentPage === 1);
  document.getElementById("btnNextPage").disabled = (currentPage === totalPages);

  container.innerHTML = pageItems.map(o => {
    const whClass = o.warehouse_tag === 'GS' ? 'wh-gs' : 'wh-uc';
    return `
      <div class="order-card">
        <div class="order-header">
          <span>#${o.customer_order_number || o.order_number} <span class="wh-pill ${whClass}">${o.warehouse_tag}</span></span>
          <div style="text-align:right;">
            <span class="tag-mode ${o.payment_mode === 'COD' ? 'tag-cod' : 'tag-prepaid'}">${o.payment_mode} - ₹${o.total_amount}</span>
            ${o.gateway ? `<span class="tag-gateway">${o.gateway}</span>` : ''}
          </div>
        </div>
        <div class="order-info"><b>AWB:</b> <code>${o.awb_number || '-'}</code></div>
        <div class="order-info"><b>Customer:</b> ${o.customer_name} (${o.phone})</div>
        <div class="order-info"><b>Destination:</b> ${o.city}, ${o.state || ''}</div>
        <div class="sku-bubble">${o.products_summary || 'Standard Item'}</div>

        ${activeTab === 'rto' ? `
          <button class="btn-act-action btn-act-received" onclick="confirmAndMarkRto('${o.awb_number}')">Mark RTO Received</button>
        ` : ''}

        ${activeTab === 'pending_payment' ? `
          <button class="btn-act-action btn-act-received" onclick="confirmAndMarkPayment('${o.awb_number}', ${o.total_amount}, '${o.payment_mode}')">Mark Paid</button>
          ${o.payment_mode === 'PREPAID' ? `<button class="btn-act-action" style="background:#f1f5f9; color:#0f172a; margin-right:8px;" onclick="verifyGatewayAudit('${o.customer_order_number || o.order_number}', ${o.total_amount})">Audit Gateway</button>` : ''}
        ` : ''}

        ${(activeTab === 'picked' || activeTab === 'rto_received' || activeTab === 'payment_received') ? `
          <button class="btn-act-action btn-undo" onclick="promptUndo('${o.awb_number}', '${activeTab.toUpperCase()}')">↩️ Undo</button>
        ` : ''}
      </div>
    `;
  }).join('');
}

// WARNING POPUP FOR RTO RECEIVED
async function confirmAndMarkRto(awb) {
  const confirmed = confirm(`⚠️ Warning Confirmation:\n\nKya aap sach me AWB: ${awb} ko "RTO Received" mark karna chahte hain?\n\n(Click OK to Confirm, Cancel to Abort)`);
  if (!confirmed) return;

  const { data: existing, error: findErr } = await sb.from('dispatches_master').select('id').eq('awb_number', awb).maybeSingle();
  if (!existing || findErr) {
    playBeep(false);
    return alert(`Action Blocked: AWB ${awb} dispatch records me nahi mila!`);
  }

  const { error } = await sb.from('dispatches_master')
    .update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' })
    .eq('awb_number', awb);

  if (!error) {
    playBeep(true);
    loadDashboard();
  } else {
    playBeep(false);
    alert("Error: " + error.message);
  }
}

// WARNING POPUP FOR PAYMENT RECEIVED
async function confirmAndMarkPayment(awb, amount, mode) {
  const confirmed = confirm(`⚠️ Payment Confirmation:\n\nKya aap AWB: ${awb} ke liye ₹${amount} (${mode}) Payment Received mark karna chahte hain?\n\n(Click OK to Confirm, Cancel to Abort)`);
  if (!confirmed) return;

  const today = new Date().toISOString().slice(0, 10);
  const gatewayLabel = (mode === 'COD') ? 'COD_CASH' : 'MANUAL_VERIFIED';

  const { error } = await sb.from('dispatches_master')
    .update({
      payment_status: 'RECEIVED',
      payment_received_amount: amount,
      payment_received_date: today,
      gateway: gatewayLabel
    })
    .eq('awb_number', awb);

  if (!error) {
    playBeep(true);
    loadDashboard();
  } else {
    playBeep(false);
    alert("Error: " + error.message);
  }
}

async function verifyGatewayAudit(orderId, expectedAmount) {
  const res = await fetch(`${API_URL}?pin=${authenticatedPin}&action=auditPrepaidGateway&orderId=${encodeURIComponent(orderId)}&amount=${expectedAmount}`).then(r => r.json());
  if (res.success) {
    alert(`Payment Verified on ${res.gateway}!\nStatus: ${res.status}\nTx ID: ${res.tx_id}\nAmount: ₹${res.amount}`);
  } else {
    alert("Payment verification failed on Razorpay / Gokwik. Please check manual UTR.");
  }
}

function openActionModal(mode) {
  currentActionMode = mode;
  const modal = document.getElementById("actionModal");
  const title = document.getElementById("modalTitle");

  if (mode === "pickup") title.innerText = "📦 Pickup Operation";
  else if (mode === "return") title.innerText = "↩️ Return Processing (RTO Received)";
  else if (mode === "payment") title.innerText = "💰 Payment Reconciliation";

  document.getElementById("selectedDate").value = new Date().toISOString().slice(0, 10);
  switchInputMode('manual');
  switchSubTab('single');
  cancelPreview();
  modal.style.display = "flex";
}

function closeActionModal() {
  stopCamera();
  document.getElementById("actionModal").style.display = "none";
}

function switchInputMode(mode) {
  const btnManual = document.getElementById("btnModeManual");
  const btnCam = document.getElementById("btnModeCamera");
  const camSec = document.getElementById("cameraSection");
  const manSec = document.getElementById("manualSection");

  if (mode === "manual") {
    btnManual.classList.add("active");
    btnCam.classList.remove("active");
    camSec.style.display = "none";
    manSec.style.display = "block";
    stopCamera();
  } else {
    btnCam.classList.add("active");
    btnManual.classList.remove("active");
    camSec.style.display = "block";
    manSec.style.display = "none";
    startCamera();
  }
}

function switchSubTab(sub) {
  document.getElementById("btnSubSingle").classList.toggle("active", sub === 'single');
  document.getElementById("btnSubBulk").classList.toggle("active", sub === 'bulk');
  document.getElementById("singleForm").style.display = (sub === 'single') ? "block" : "none";
  document.getElementById("bulkForm").style.display = (sub === 'bulk') ? "block" : "none";
  cancelPreview();
}

// LOOKUP LOGIC (STRICT SUPABASE ONLY FOR RETURN / PAYMENT)
async function lookupSingleAwb() {
  const awb = document.getElementById("inputSingleAwb").value.trim();
  if (!awb) return alert("Please specify a valid AWB number.");

  // PICKUP MODE
  if (currentActionMode === "pickup") {
    const { data: existing } = await sb.from('dispatches_master').select('date').eq('awb_number', awb).maybeSingle();
    if (existing) {
      playBeep(false);
      return alert(`Duplicate blocked: AWB ${awb} was already logged on ${existing.date}.`);
    }

    fetch(`${API_URL}?pin=${authenticatedPin}&action=previewAwb&awb=${encodeURIComponent(awb)}`)
      .then(r => r.json())
      .then(res => {
        if (!res.success) {
          playBeep(false);
          alert("Verification Failed: " + res.error);
          cancelPreview();
        } else {
          playBeep(true);
          pendingAwbData = res.data;
          const d = res.data;
          document.getElementById("previewContent").innerHTML = `
            <div style="font-size:13px; font-weight:800; color:var(--jelly-blue); margin-bottom:4px;">✅ AWB Verified: ${d.awb}</div>
            <div style="font-size:12px;"><b>Order ID:</b> #${d.customer_order_number} (${d.warehouse_tag})</div>
            <div style="font-size:12px;"><b>Customer:</b> ${d.customer_name} (${d.phone})</div>
            <div style="font-size:12px;"><b>Destination:</b> ${d.city}, ${d.state}</div>
            <div style="font-size:12px;"><b>Invoice Amount:</b> ₹${d.total_amount} (${d.payment_mode})</div>
            <div style="font-size:11.5px; color:#475569; margin-top:4px;"><b>Products:</b> ${d.products_summary}</div>
          `;
          document.getElementById("previewCard").style.display = "block";
        }
      });
  } 
  // RETURN & PAYMENT MODE: STRICT SUPABASE SEARCH
  else {
    const { data: existing, error } = await sb.from('dispatches_master').select('*').eq('awb_number', awb).maybeSingle();
    if (!existing || error) {
      playBeep(false);
      cancelPreview();
      return alert(`Action Blocked: AWB ${awb} database me nahi mila. Invalid Scan!`);
    }

    playBeep(true);
    pendingAwbData = existing;
    document.getElementById("previewContent").innerHTML = `
      <div style="font-size:13px; font-weight:800; color:var(--jelly-blue); margin-bottom:4px;">✅ Matched Order: #${existing.customer_order_number}</div>
      <div style="font-size:12px;"><b>Customer:</b> ${existing.customer_name} (${existing.city})</div>
      <div style="font-size:12px;"><b>Stage:</b> ${existing.current_stage} | <b>Amount:</b> ₹${existing.total_amount} (${existing.payment_mode})</div>
    `;
    document.getElementById("previewCard").style.display = "block";
  }
}

async function confirmSaveSingle() {
  if (!pendingAwbData) return;
  const d = pendingAwbData;
  const date = document.getElementById("selectedDate").value;

  let error = null;

  if (currentActionMode === "pickup") {
    const res = await sb.from('dispatches_master').insert([{
      date: date,
      awb_number: d.awb,
      customer_order_number: d.customer_order_number,
      order_number: d.order_number,
      warehouse_tag: d.warehouse_tag,
      customer_name: d.customer_name,
      phone: d.phone,
      city: d.city,
      state: d.state,
      payment_mode: d.payment_mode,
      total_amount: d.total_amount,
      products_summary: d.products_summary,
      payment_status: "PENDING",
      payment_received_amount: 0,
      packed_status: "PICKED_UP",
      current_stage: "PICKED"
    }]);
    error = res.error;
  } else if (currentActionMode === "return") {
    const confirmed = confirm(`⚠️ Warning: Kya aap AWB ${d.awb_number} ko RTO Received mark karna chahte hain?`);
    if (!confirmed) return;

    const res = await sb.from('dispatches_master')
      .update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' })
      .eq('awb_number', d.awb_number);
    error = res.error;
  } else if (currentActionMode === "payment") {
    const confirmed = confirm(`⚠️ Warning: Kya aap AWB ${d.awb_number} ke liye payment confirm karna chahte hain?`);
    if (!confirmed) return;

    const res = await sb.from('dispatches_master')
      .update({
        payment_status: 'RECEIVED',
        payment_received_amount: d.total_amount,
        payment_received_date: date,
        gateway: (d.payment_mode === 'COD') ? 'COD_CASH' : 'MANUAL_VERIFIED'
      })
      .eq('awb_number', d.awb_number);
    error = res.error;
  }

  if (!error) {
    playBeep(true);
    closeActionModal();
    loadDashboard();
  } else {
    playBeep(false);
    alert("Error saving: " + error.message);
  }
}

function cancelPreview() {
  pendingAwbData = null;
  document.getElementById("previewCard").style.display = "none";
  document.getElementById("inputSingleAwb").value = "";
}

async function submitBulkAwbs() {
  const text = document.getElementById("inputBulkAwbs").value.trim();
  const date = document.getElementById("selectedDate").value;
  const lines = text.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
  if (lines.length === 0) return alert("Please paste one or more AWB numbers.");

  const processed = [];
  const failed = [];

  for (const awb of lines) {
    try {
      if (currentActionMode === "pickup") {
        const preview = await fetch(`${API_URL}?pin=${authenticatedPin}&action=previewAwb&awb=${encodeURIComponent(awb)}`).then(r => r.json());
        if (preview.success) {
          const d = preview.data;
          const { error } = await sb.from('dispatches_master').insert([{
            date: date,
            awb_number: d.awb,
            customer_order_number: d.customer_order_number,
            order_number: d.order_number,
            warehouse_tag: d.warehouse_tag,
            customer_name: d.customer_name,
            phone: d.phone,
            city: d.city,
            state: d.state,
            payment_mode: d.payment_mode,
            total_amount: d.total_amount,
            products_summary: d.products_summary,
            payment_status: "PENDING",
            payment_received_amount: 0,
            packed_status: "PICKED_UP",
            current_stage: "PICKED"
          }]);
          if (!error) processed.push({ awb });
          else failed.push({ awb, reason: error.message });
        } else {
          failed.push({ awb, reason: preview.error });
        }
      } else if (currentActionMode === "return") {
        const { data: existing } = await sb.from('dispatches_master').select('id').eq('awb_number', awb).maybeSingle();
        if (existing) {
          await sb.from('dispatches_master').update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' }).eq('awb_number', awb);
          processed.push({ awb });
        } else {
          failed.push({ awb, reason: "Order not found in database." });
        }
      } else if (currentActionMode === "payment") {
        const { data: existing } = await sb.from('dispatches_master').select('id, total_amount, payment_mode').eq('awb_number', awb).maybeSingle();
        if (existing) {
          await sb.from('dispatches_master').update({
            payment_status: 'RECEIVED',
            payment_received_amount: existing.total_amount,
            payment_received_date: date,
            gateway: (existing.payment_mode === 'COD') ? 'COD_CASH' : 'MANUAL_VERIFIED'
          }).eq('awb_number', awb);
          processed.push({ awb });
        } else {
          failed.push({ awb, reason: "Order not found in database." });
        }
      }
    } catch (e) {
      failed.push({ awb, reason: e.toString() });
    }
  }

  playBeep(true);
  closeActionModal();
  displayBulkSummary({
    processed_count: processed.length,
    failed_count: failed.length,
    processed,
    failed
  });
}

function displayBulkSummary(res) {
  document.getElementById("sumSuccessCount").innerText = res.processed_count;
  document.getElementById("sumFailedCount").innerText = res.failed_count;

  const secSuccess = document.getElementById("sectionSuccessChips");
  const chipsSuccess = document.getElementById("chipsSuccess");
  chipsSuccess.innerHTML = "";
  if (res.processed && res.processed.length > 0) {
    secSuccess.style.display = "block";
    res.processed.forEach(item => chipsSuccess.innerHTML += `<span class="chip chip-success">${item.awb}</span>`);
  } else {
    secSuccess.style.display = "none";
  }

  const secFailed = document.getElementById("sectionFailedChips");
  const chipsFailed = document.getElementById("chipsFailed");
  chipsFailed.innerHTML = "";
  if (res.failed && res.failed.length > 0) {
    secFailed.style.display = "block";
    res.failed.forEach(item => chipsFailed.innerHTML += `<span class="chip chip-failed" title="${item.reason}">${item.awb}</span>`);
  } else {
    secFailed.style.display = "none";
  }

  document.getElementById("bulkSummaryModal").style.display = "flex";
}

function closeBulkSummaryModal() {
  document.getElementById("bulkSummaryModal").style.display = "none";
  loadDashboard();
}

// OPTICAL CAMERA SCANNER (STRICT WORKFLOW)
function startCamera() {
  if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 15, qrbox: { width: 280, height: 160 } },
    async decodedText => {
      const awb = decodedText.trim();
      if (!awb) return;

      stopCamera();
      document.getElementById("inputSingleAwb").value = awb;

      if (currentActionMode === "return") {
        // Strict Supabase camera check with Warning Popup
        const { data: existing, error } = await sb.from('dispatches_master').select('*').eq('awb_number', awb).maybeSingle();
        if (!existing || error) {
          playBeep(false);
          alert(`Scan Blocked: AWB ${awb} dispatch records me nahi mila!`);
          switchInputMode('manual');
          return;
        }

        const confirmed = confirm(`⚠️ Warning Confirmation:\n\nCamera ne AWB: ${awb} detect kiya hai.\nOrder: #${existing.customer_order_number} (${existing.customer_name})\n\nKya aap ise "RTO Received" mark karna chahte hain?`);
        if (confirmed) {
          await sb.from('dispatches_master').update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' }).eq('awb_number', awb);
          playBeep(true);
          closeActionModal();
          loadDashboard();
        } else {
          switchInputMode('manual');
        }
      } else {
        switchInputMode('manual');
        lookupSingleAwb();
      }
    }
  ).catch(e => console.warn(e));
}

function stopCamera() {
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().catch(() => {});
  }
}

async function promptUndo(awb, stage) {
  const conf = confirm(`Security Confirmation:\n\nAre you sure you want to revert or delete AWB ${awb}?\n\n(Click OK to confirm, Cancel to abort)`);
  if (!conf) return;

  let error = null;
  if (stage === "PICKED") {
    const res = await sb.from('dispatches_master').delete().eq('awb_number', awb);
    error = res.error;
  } else if (stage === "RTO_RECEIVED") {
    const res = await sb.from('dispatches_master')
      .update({ packed_status: 'PICKED_UP', current_stage: 'RTO' })
      .eq('awb_number', awb);
    error = res.error;
  } else if (stage === "PAYMENT_RECEIVED") {
    const res = await sb.from('dispatches_master')
      .update({ payment_status: 'PENDING', payment_received_amount: 0, payment_received_date: null, gateway: null })
      .eq('awb_number', awb);
    error = res.error;
  }

  if (!error) {
    playBeep(true);
    loadDashboard();
  } else {
    playBeep(false);
    alert("Revert Operation Failed: " + error.message);
  }
}
