/**
 * Harsidhi Ventures ERP - Client Controller
 * Developed by: Kamlesh Hargun
 */

const API_URL = "https://script.google.com/macros/s/AKfycbxTrU_KwblhLu6RqnpBdhPgi995_WskN0EXxDLSrHJmFUF2gWG_Jx6lymNp4pau0XM6/exec";

// Supabase Configuration
const SUPABASE_URL = "https://bkmynjioyjtzzjtwloee.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJrbXluamlveWp0enpqdHdsb2VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNDI5MzIsImV4cCI6MjEwNzgxODkzMn0.L34UB_G55TSP9EAW9Xox-obUUe8XsVIwDTJ8XwfQ85A";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let authenticatedPin = "";
let dashboardData = {};
let activeTab = "all_orders";
let currentActionMode = "pickup";
let html5QrCode = null;
let pendingAwbData = null;

let isContinuousScanning = false;
let continuousSessionCount = 0;

let currentPage = 1;
let pageSize = 50;
let reconSortAsc = false;

// Point 6: Warehouse Audio and Haptic Feedback Engine
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playHapticBeep(type) {
  // Hardware Haptic Feedback
  if ("vibrate" in navigator) {
    if (type === "success") navigator.vibrate(60);
    else if (type === "duplicate") navigator.vibrate([100, 50, 100]);
    else if (type === "error") navigator.vibrate([200, 80, 200]);
  }

  // Audio Tones
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (type === "success") {
      osc.frequency.setValueAtTime(880, ctx.currentTime); // High pitch A5
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(); osc.stop(ctx.currentTime + 0.25);
    } else if (type === "duplicate") {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(); osc.stop(ctx.currentTime + 0.35);
    } else {
      osc.frequency.setValueAtTime(220, ctx.currentTime); // Low pitch error tone
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(); osc.stop(ctx.currentTime + 0.4);
    }
    osc.connect(gain); gain.connect(ctx.destination);
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
        document.getElementById("pinError").style.display = "block";
        const inputs = document.querySelectorAll(".pin-digit");
        inputs.forEach(i => i.value = "");
        inputs[0].focus();
        playHapticBeep("error");
      }
    })
    .catch(() => {
      document.getElementById("pinError").style.display = "block";
      playHapticBeep("error");
    });
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

async function fetchIncomingDelhiveryReversePickups() {
  try {
    const { data, error } = await sb.from('incoming_reverse_pickups').select('*').order('created_at', { ascending: false });
    if (error || !data) return [];
    return data;
  } catch(e) {
    return [];
  }
}

async function loadDashboard() {
  document.getElementById("ordersContainer").innerHTML = '<div style="text-align:center; padding:35px; color:var(--text-muted);">Synchronizing enterprise records...</div>';

  try {
    const [supabaseOrders, incomingReverseList, carrierRes] = await Promise.all([
      fetchAllSupabaseRows(),
      fetchIncomingDelhiveryReversePickups(),
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
    const skuCounter = {};

    let totalDispatchedAmt = 0;
    let totalRealizedAmt = 0;
    let totalInTransitAmt = 0;
    let totalRtoLossAmt = 0;

    let todayCount = 0;
    let todayGs = 0;
    let todayUc = 0;
    let yesterdayCount = 0;
    let monthCount = 0;

    let deliveredCount = 0;
    let rtoCount = 0;
    let rtoReceivedCount = 0;

    const pastOrdersToTrack = [];

    const dbOrders = supabaseOrders.map(row => {
      const scanDateStr = String(row.date || "").slice(0, 10);
      const awbVal = String(row.awb_number || "").trim();
      const whTag = String(row.warehouse_tag || "OTHER").toUpperCase();
      const rowAmt = parseFloat(row.total_amount || 0);
      const payStatus = String(row.payment_status || "PENDING").trim();
      let currentStage = String(row.current_stage || "PICKED").trim();

      if (scanDateStr === todayStr) {
        currentStage = "PICKED";
      } else if (currentStage === "PICKED") {
        currentStage = "IN_TRANSIT";
        pastOrdersToTrack.push(awbVal);
      }

      if (awbVal) pickedUpMap[awbVal] = { stage: currentStage, scanDate: scanDateStr };

      totalDispatchedAmt += rowAmt;
      if (payStatus === "RECEIVED") {
        totalRealizedAmt += parseFloat(row.payment_received_amount || rowAmt);
      } else if (currentStage === "IN_TRANSIT" || currentStage === "OUT_FOR_DELIVERY") {
        totalInTransitAmt += rowAmt;
      }

      if (currentStage === "DELIVERED") deliveredCount++;
      if (currentStage === "RTO" || currentStage === "RTO_RECEIVED") {
        rtoCount++;
        totalRtoLossAmt += rowAmt;
      }
      if (currentStage === "RTO_RECEIVED") rtoReceivedCount++;

      // SKU Frequency count
      const summaryText = String(row.products_summary || "").trim();
      if (summaryText) {
        const items = summaryText.split(/[|,]+/);
        items.forEach(it => {
          const cleanSku = it.trim().split(" (")[0].trim();
          if (cleanSku && cleanSku !== "Standard Item") {
            skuCounter[cleanSku] = (skuCounter[cleanSku] || 0) + 1;
          }
        });
      }

      // Reconciliation & KPI counts
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
          todayCount++;
          if (whTag === "GS") todayGs++;
          else if (whTag === "UC") todayUc++;
        }
        if (scanDateStr === yesterdayStr) yesterdayCount++;
        if (scanDateStr.startsWith(monthPrefix)) monthCount++;
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
        return_condition: row.return_condition || "INTACT",
        is_incoming_reverse: false
      };
    });

    // Background tracking sync for past in-transit records (Non-blocking)
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

    const rtoQueueList = [...dbOrders.filter(o => o.current_stage === "RTO")];
    incomingReverseList.forEach(item => {
      if (!pickedUpMap[item.awb_number]) {
        rtoQueueList.push({
          date: String(item.created_at || todayStr).slice(0, 10),
          awb_number: item.awb_number,
          customer_order_number: item.customer_order_number || "-",
          order_number: item.customer_order_number || "-",
          warehouse_tag: "DELHIVERY",
          customer_name: item.customer_name || "Customer Return",
          phone: item.phone || "",
          city: item.city || "",
          state: item.state || "",
          payment_mode: "RETURN",
          total_amount: parseFloat(item.total_amount || 0),
          products_summary: item.products_summary || "Reverse Logistics Packet",
          payment_status: "PENDING",
          current_stage: "RTO",
          is_incoming_reverse: true
        });
      }
    });

    // Sorted Top SKUs
    const topSkus = Object.entries(skuCounter).sort((a,b) => b[1] - a[1]);
    const topSkuString = topSkus.length > 0 ? `${topSkus[0][0]} (${topSkus[0][1]} Units)` : "No SKU data recorded";

    const deliveryPercent = dbOrders.length > 0 ? ((deliveredCount / dbOrders.length) * 100).toFixed(1) : "0.0";
    const rtoPercent = dbOrders.length > 0 ? ((rtoCount / dbOrders.length) * 100).toFixed(1) : "0.0";
    const recoveryPercent = rtoCount > 0 ? ((rtoReceivedCount / rtoCount) * 100).toFixed(0) : "100";

    const reconList = Object.values(dateWiseRecon).sort((a, b) => b.date.localeCompare(a.date));

    dashboardData = {
      rawOrders: dbOrders,
      metrics: {
        totalDispatchedAmt, totalRealizedAmt, totalInTransitAmt, totalRtoLossAmt,
        todayCount, todayGs, todayUc, yesterdayCount, monthCount,
        deliveryPercent, deliveredCount, rtoPercent, recoveryPercent,
        topSkuString, totalActiveSkus: Object.keys(skuCounter).length
      },
      date_wise_recon: reconList,
      all_orders: allOrders,
      pickup_failed: pickupFailed,
      picked: dbOrders.filter(o => o.current_stage === "PICKED" && o.date === todayStr),
      intransit: dbOrders.filter(o => o.current_stage === "IN_TRANSIT"),
      out_for_delivery: dbOrders.filter(o => o.current_stage === "OUT_FOR_DELIVERY"),
      delivered: dbOrders.filter(o => o.current_stage === "DELIVERED"),
      rto: rtoQueueList,
      rto_received: dbOrders.filter(o => o.current_stage === "RTO_RECEIVED"),
      pending_payment: dbOrders.filter(o => o.payment_status === "PENDING"),
      payment_received: dbOrders.filter(o => o.payment_status === "RECEIVED")
    };

    renderEnterpriseMetricPanels();
    renderCounts();
    currentPage = 1;
    renderActiveTab();
  } catch (err) {
    document.getElementById("ordersContainer").innerHTML = `<div style="text-align:center; padding:35px; color:var(--danger);">Synchronization Failed: ${err.message}</div>`;
  }
}

function renderEnterpriseMetricPanels() {
  const m = dashboardData.metrics;
  if (!m) return;

  document.getElementById("metricCollectedAmt").innerText = "₹" + m.totalRealizedAmt.toLocaleString('en-IN');
  document.getElementById("metricInvoiceTotal").innerText = "Total Dispatched: ₹" + m.totalDispatchedAmt.toLocaleString('en-IN');
  document.getElementById("metricFloatingCash").innerText = "In-Transit: ₹" + m.totalInTransitAmt.toLocaleString('en-IN');
  document.getElementById("metricRtoLoss").innerText = "RTO Drain: ₹" + m.totalRtoLossAmt.toLocaleString('en-IN');

  document.getElementById("metricTodayDispatchedCount").innerText = m.todayCount + " pkts";
  document.getElementById("metricYesterdayDispatched").innerText = "Yesterday: " + m.yesterdayCount + " pkts";
  document.getElementById("badgeGsVelocity").innerText = "GS: " + m.todayGs;
  document.getElementById("badgeUcVelocity").innerText = "UC: " + m.todayUc;

  document.getElementById("metricDeliveryRate").innerText = m.deliveryPercent + "%";
  document.getElementById("metricDeliveredCount").innerText = m.deliveredCount + " Successfully Delivered";
  document.getElementById("metricRtoRate").innerText = "RTO: " + m.rtoPercent + "%";
  document.getElementById("metricRecoveryRate").innerText = "Return Recovery: " + m.recoveryPercent + "%";

  document.getElementById("metricTopSku").innerText = m.topSkuString;
  document.getElementById("metricMonthlyVolume").innerText = "Monthly Volume: " + m.monthCount + " Orders";
  document.getElementById("metricActiveSkus").innerText = "Active SKUs in Circulation: " + m.totalActiveSkus;
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
  const fullList = getFilteredActiveList();
  const totalPages = Math.ceil(fullList.length / pageSize) || 1;
  if (currentPage < totalPages) {
    currentPage++;
    renderActiveTab();
    window.scrollTo({ top: 300, behavior: 'smooth' });
  }
}

// Point 1: Universal Search & Multi-Filter Engine
function handleUniversalSearch() {
  currentPage = 1;
  renderActiveTab();
}

function applyUniversalFilters() {
  currentPage = 1;
  renderActiveTab();
}

function getFilteredActiveList() {
  let list = [];
  if (activeTab === "daily_recon") return dashboardData.date_wise_recon || [];
  if (activeTab === "analytics") return [];
  list = dashboardData[activeTab] || [];

  const query = (document.getElementById("globalSearchInput")?.value || "").toLowerCase().trim();
  const brandFilter = document.getElementById("filterBrandSelect")?.value || "ALL";
  const payFilter = document.getElementById("filterPaymentModeSelect")?.value || "ALL";
  const dateFilter = document.getElementById("filterDateRangeSelect")?.value || "ALL";

  const todayStr = new Date().toISOString().slice(0, 10);
  const yestStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monthPrefix = todayStr.slice(0, 7);

  return list.filter(o => {
    // 1. Text Query Match
    if (query) {
      const matchAwb = String(o.awb_number || "").toLowerCase().includes(query);
      const matchOrder = String(o.customer_order_number || o.order_number || "").toLowerCase().includes(query);
      const matchCust = String(o.customer_name || "").toLowerCase().includes(query);
      const matchPhone = String(o.phone || "").toLowerCase().includes(query);
      if (!matchAwb && !matchOrder && !matchCust && !matchPhone) return false;
    }

    // 2. Brand Filter Match
    if (brandFilter !== "ALL" && o.warehouse_tag !== brandFilter) return false;

    // 3. Payment Mode Filter
    if (payFilter !== "ALL" && o.payment_mode !== payFilter) return false;

    // 4. Date Range Filter
    if (dateFilter === "TODAY" && o.date !== todayStr) return false;
    if (dateFilter === "YESTERDAY" && o.date !== yestStr) return false;
    if (dateFilter === "LAST_7_DAYS" && o.date < sevenDaysAgo) return false;
    if (dateFilter === "THIS_MONTH" && !String(o.date).startsWith(monthPrefix)) return false;

    return true;
  });
}

function renderActiveTab() {
  const container = document.getElementById("ordersContainer");
  const paginationBar = document.getElementById("paginationBar");

  // Visual Interactive Analytics View
  if (activeTab === "analytics") {
    paginationBar.style.display = "none";
    renderVisualAnalyticsCharts(container);
    return;
  }

  // Date-Wise Reconciliation View
  if (activeTab === "daily_recon") {
    paginationBar.style.display = "none";
    let list = [...(dashboardData.date_wise_recon || [])];
    if (list.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:35px; color:var(--text-muted);">No reconciliation records generated yet.</div>`;
      return;
    }

    list.sort((a, b) => reconSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
    const sortArrow = reconSortAsc ? "▲ Ascending" : "▼ Descending";

    let html = `
      <div class="recon-table-wrap">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th>#</th>
              <th class="sortable" onclick="toggleReconSort()">Dispatch Date ${sortArrow}</th>
              <th>Total Packets</th>
              <th>Total Invoice Value</th>
              <th>Payment Realized</th>
              <th>Pending Count</th>
            </tr>
          </thead>
          <tbody>
    `;
    list.forEach((r, idx) => {
      html += `
        <tr>
          <td style="color:var(--text-muted);">${idx + 1}</td>
          <td><b>📅 ${r.date}</b></td>
          <td>${r.count} pkts</td>
          <td style="font-weight:800;">₹${r.total_amount.toLocaleString('en-IN')}</td>
          <td style="color:var(--success); font-weight:800;">₹${r.received_amount.toLocaleString('en-IN')}</td>
          <td style="color:${r.pending_count > 0 ? '#b45309' : '#047857'}; font-weight:800;">${r.pending_count} pending</td>
        </tr>
      `;
    });
    html += `</tbody></table></div>`;
    container.innerHTML = html;
    return;
  }

  // Standard Order Cards View
  paginationBar.style.display = "flex";
  const fullList = getFilteredActiveList();

  if (fullList.length === 0) {
    paginationBar.style.display = "none";
    container.innerHTML = `<div style="text-align:center; padding:35px; color:var(--text-muted);">No records match your active search and filter criteria.</div>`;
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
    const isDelhiveryReverse = Boolean(o.is_incoming_reverse);
    const whClass = isDelhiveryReverse ? 'wh-reverse' : (o.warehouse_tag === 'GS' ? 'wh-gs' : 'wh-uc');
    const whLabel = isDelhiveryReverse ? 'Delhivery Reverse' : o.warehouse_tag;

    return `
      <div class="order-card">
        <div>
          <div class="order-header">
            <span>#${o.customer_order_number || o.order_number} <span class="wh-pill ${whClass}">${whLabel}</span></span>
            <div style="text-align:right;">
              <span class="tag-mode ${o.payment_mode === 'COD' ? 'tag-cod' : 'tag-prepaid'}">${o.payment_mode} - ₹${o.total_amount}</span>
              ${o.gateway ? `<span class="tag-gateway">${o.gateway}</span>` : ''}
            </div>
          </div>
          <div class="order-info"><b>AWB:</b> <code>${o.awb_number || '-'}</code></div>
          <div class="order-info"><b>Customer:</b> ${o.customer_name} (${o.phone})</div>
          <div class="order-info"><b>Destination:</b> ${o.city}, ${o.state || ''}</div>
          <div class="sku-bubble">${o.products_summary || 'Standard Apparel Package'}</div>
        </div>

        <div class="card-actions-wrapper">
          <!-- Point 3: Customer WhatsApp Action Ping Trigger -->
          <button class="btn-act-action btn-whatsapp" onclick="triggerCustomerWhatsAppMessage('${o.phone}', '${o.customer_name}', '${o.customer_order_number}', '${o.awb_number}', '${o.current_stage}')">💬 WhatsApp</button>

          ${activeTab === 'rto' ? `
            <button class="btn-act-action btn-act-received" onclick="confirmAndMarkRto('${o.awb_number}', ${isDelhiveryReverse ? JSON.stringify(JSON.stringify(o)) : 'null'})">Mark RTO Received</button>
          ` : ''}

          ${activeTab === 'pending_payment' ? `
            <button class="btn-act-action btn-act-received" onclick="confirmAndMarkPayment('${o.awb_number}', ${o.total_amount}, '${o.payment_mode}')">Mark Paid</button>
            ${o.payment_mode === 'PREPAID' ? `<button class="btn-act-action" style="background:#f1f5f9; color:#0f172a;" onclick="verifyGatewayAudit('${o.customer_order_number || o.order_number}', ${o.total_amount})">Audit Gateway</button>` : ''}
          ` : ''}

          ${(activeTab === 'picked' || activeTab === 'rto_received' || activeTab === 'payment_received') ? `
            <button class="btn-act-action btn-undo" onclick="promptUndo('${o.awb_number}', '${activeTab.toUpperCase()}')">↩️ Undo</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Visual Interactive Charts Generator (Section 4 Analytics)
function renderVisualAnalyticsCharts(container) {
  const recon = (dashboardData.date_wise_recon || []).slice(0, 7).reverse();
  const dates = recon.map(r => r.date.slice(5));
  const counts = recon.map(r => r.count);
  const amounts = recon.map(r => r.received_amount);

  container.innerHTML = `
    <div class="analytics-dashboard-wrap">
      <div class="chart-card">
        <div class="chart-title">7-Day Dispatch Velocity Trend <span>Packets</span></div>
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">Daily fulfillment volume across all warehouses.</div>
        <div style="display:flex; justify-content:space-between; align-items:flex-end; height:160px; padding:10px 0; border-bottom:1px solid #e2e8f0;">
          ${counts.map((c, i) => `
            <div style="flex:1; text-align:center;">
              <div style="font-size:11px; font-weight:800; margin-bottom:4px;">${c}</div>
              <div style="height:${Math.min(c * 6, 120)}px; background:var(--primary-accent); border-radius:6px 6px 0 0; margin:0 4px;"></div>
              <div style="font-size:10.5px; font-weight:700; color:var(--text-muted); margin-top:6px;">${dates[i] || '-'}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="chart-card">
        <div class="chart-title">Payment Realization Rate <span>₹ Collected</span></div>
        <div style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">Realized bank settlements vs pending float.</div>
        <div style="display:flex; justify-content:space-between; align-items:flex-end; height:160px; padding:10px 0; border-bottom:1px solid #e2e8f0;">
          ${amounts.map((a, i) => `
            <div style="flex:1; text-align:center;">
              <div style="font-size:10px; font-weight:800; margin-bottom:4px;">₹${(a/1000).toFixed(0)}k</div>
              <div style="height:${Math.min((a / 800), 120)}px; background:var(--success); border-radius:6px 6px 0 0; margin:0 4px;"></div>
              <div style="font-size:10.5px; font-weight:700; color:var(--text-muted); margin-top:6px;">${dates[i] || '-'}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

// Point 3: Smart Customer WhatsApp Ping Generator
function triggerCustomerWhatsAppMessage(phone, name, orderId, awb, stage) {
  const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
  if (!cleanPhone || cleanPhone.length < 10) return alert("Invalid customer phone number recorded for this order.");

  const formattedPhone = cleanPhone.length === 10 ? ("91" + cleanPhone) : cleanPhone;
  let text = `Hello ${name}, your order #${orderId} from Harsidhi Ventures is confirmed! Tracking AWB: ${awb}.`;
  
  if (stage === "OUT_FOR_DELIVERY") {
    text = `Hello ${name}, your parcel #${orderId} is OUT FOR DELIVERY today! Please keep the payment amount ready. Tracking AWB: ${awb}.`;
  } else if (stage === "PICKED") {
    text = `Hello ${name}, your order #${orderId} has been packed and handed over to the courier partner! AWB: ${awb}.`;
  }

  const url = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank');
}

// Point 4: Printable Courier Manifest Slip Generator
function generateAndPrintManifestSlip() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOrders = (dashboardData.rawOrders || []).filter(o => o.date === todayStr);

  if (todayOrders.length === 0) {
    return alert("No orders recorded for today's date to generate the manifest slip.");
  }

  let totalCod = 0;
  let tableRows = todayOrders.map((o, idx) => {
    if (o.payment_mode === "COD") totalCod += parseFloat(o.total_amount || 0);
    return `
      <tr>
        <td style="border:1px solid #000; padding:6px; font-size:12px;">${idx + 1}</td>
        <td style="border:1px solid #000; padding:6px; font-size:12px;"><b>${o.awb_number}</b></td>
        <td style="border:1px solid #000; padding:6px; font-size:12px;">#${o.customer_order_number} (${o.warehouse_tag})</td>
        <td style="border:1px solid #000; padding:6px; font-size:12px;">${o.customer_name}</td>
        <td style="border:1px solid #000; padding:6px; font-size:12px;">${o.city}, ${o.state}</td>
        <td style="border:1px solid #000; padding:6px; font-size:12px;">${o.payment_mode}</td>
        <td style="border:1px solid #000; padding:6px; font-size:12px;">₹${o.total_amount}</td>
      </tr>
    `;
  }).join('');

  const slipHtml = `
    <div style="font-family:sans-serif; padding:10px;">
      <h2 style="margin-bottom:4px;">🏢 HARSIDHI VENTURES - DISPATCH HANDOVER MANIFEST</h2>
      <p style="font-size:13px; margin-bottom:12px;">Date: <b>${todayStr}</b> | Total Packages: <b>${todayOrders.length}</b> | COD Amount: <b>₹${totalCod.toLocaleString('en-IN')}</b></p>
      
      <table style="width:100%; border-collapse:collapse; text-align:left; margin-bottom:30px;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="border:1px solid #000; padding:6px; font-size:12px;">#</th>
            <th style="border:1px solid #000; padding:6px; font-size:12px;">AWB Number</th>
            <th style="border:1px solid #000; padding:6px; font-size:12px;">Order ID (Brand)</th>
            <th style="border:1px solid #000; padding:6px; font-size:12px;">Customer Name</th>
            <th style="border:1px solid #000; padding:6px; font-size:12px;">Destination</th>
            <th style="border:1px solid #000; padding:6px; font-size:12px;">Mode</th>
            <th style="border:1px solid #000; padding:6px; font-size:12px;">Amount</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>

      <div style="display:flex; justify-content:space-between; margin-top:40px;">
        <div style="border-top:1px solid #000; width:220px; text-align:center; padding-top:6px; font-size:12px;">
          Warehouse Dispatcher Signature
        </div>
        <div style="border-top:1px solid #000; width:220px; text-align:center; padding-top:6px; font-size:12px;">
          Courier Pickup Executive Signature
        </div>
      </div>
    </div>
  `;

  const printArea = document.getElementById("printManifestArea");
  printArea.innerHTML = slipHtml;
  window.print();
}

// Point 2: Rapid-Fire Continuous Mode Toggle
function toggleContinuousScanningMode() {
  isContinuousScanning = !isContinuousScanning;
  document.getElementById("chkContinuousScan").checked = isContinuousScanning;
  const counterBadge = document.getElementById("rapidScanCounter");
  
  if (isContinuousScanning) {
    continuousSessionCount = 0;
    counterBadge.style.display = "inline";
    counterBadge.innerText = `(Session: 0)`;
    playHapticBeep("success");
    openActionModal("pickup");
    switchInputMode("camera");
  } else {
    counterBadge.style.display = "none";
  }
}

async function confirmAndMarkRto(awb, rawStagingObj) {
  const confirmed = confirm(`⚠️ Warning Confirmation:\n\nAre you sure you want to mark AWB: ${awb} as RTO RECEIVED?`);
  if (!confirmed) return;

  const today = new Date().toISOString().slice(0, 10);

  if (rawStagingObj) {
    let stagingItem = {};
    try { stagingItem = JSON.parse(rawStagingObj); } catch(e) {}

    const { error: insErr } = await sb.from('dispatches_master').insert([{
      date: today,
      awb_number: awb,
      customer_order_number: stagingItem.customer_order_number || "-",
      order_number: stagingItem.order_number || "-",
      warehouse_tag: "DELHIVERY",
      customer_name: stagingItem.customer_name || "Customer Return",
      phone: stagingItem.phone || "",
      city: stagingItem.city || "",
      state: stagingItem.state || "",
      payment_mode: "RETURN",
      total_amount: parseFloat(stagingItem.total_amount || 0),
      products_summary: stagingItem.products_summary || "Reverse Logistics Packet",
      payment_status: "PENDING",
      payment_received_amount: 0,
      gateway: "DELHIVERY_REVERSE",
      packed_status: "RTO_RECEIVED",
      current_stage: "RTO_RECEIVED",
      return_condition: "INTACT"
    }]);

    if (!insErr) {
      await sb.from('incoming_reverse_pickups').delete().eq('awb_number', awb);
      playHapticBeep("success");
      loadDashboard();
    } else {
      playHapticBeep("error");
      alert("Error: " + insErr.message);
    }
    return;
  }

  const { data: existing, error: findErr } = await sb.from('dispatches_master').select('id').eq('awb_number', awb).maybeSingle();
  if (!existing || findErr) {
    playHapticBeep("error");
    return alert(`Action Blocked: AWB ${awb} was not located in database.`);
  }

  const { error } = await sb.from('dispatches_master')
    .update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' })
    .eq('awb_number', awb);

  if (!error) {
    playHapticBeep("success");
    loadDashboard();
  } else {
    playHapticBeep("error");
    alert("Error: " + error.message);
  }
}

async function confirmAndMarkPayment(awb, amount, mode) {
  const confirmed = confirm(`⚠️ Payment Confirmation:\n\nConfirm payment receipt of ₹${amount} (${mode}) for AWB: ${awb}?`);
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
    playHapticBeep("success");
    loadDashboard();
  } else {
    playHapticBeep("error");
    alert("Error: " + error.message);
  }
}

async function verifyGatewayAudit(orderId, expectedAmount) {
  const res = await fetch(`${API_URL}?pin=${authenticatedPin}&action=auditPrepaidGateway&orderId=${encodeURIComponent(orderId)}&amount=${expectedAmount}`).then(r => r.json());
  if (res.success) {
    playHapticBeep("success");
    alert(`Payment Verified on ${res.gateway}!\nStatus: ${res.status}\nTx ID: ${res.tx_id}\nAmount: ₹${res.amount}`);
  } else {
    playHapticBeep("error");
    alert("Payment verification unconfirmed on Razorpay / Gokwik. Please audit manual UTR.");
  }
}

function openActionModal(mode) {
  currentActionMode = mode;
  const modal = document.getElementById("actionModal");
  const title = document.getElementById("modalTitle");
  const qcBox = document.getElementById("returnQcSection");

  if (mode === "pickup") {
    title.innerText = "📦 Warehouse Dispatch Scan";
    qcBox.style.display = "none";
  } else if (mode === "return") {
    title.innerText = "↩️ Return Logistics Scan (RTO Received)";
    qcBox.style.display = "block";
  } else if (mode === "payment") {
    title.innerText = "💰 Payment Reconciliation Scan";
    qcBox.style.display = "none";
  }

  document.getElementById("selectedDate").value = new Date().toISOString().slice(0, 10);
  switchInputMode('manual');
  switchSubTab('single');
  cancelPreview();
  modal.style.display = "flex";
}

function closeActionModal() {
  stopCamera();
  document.getElementById("actionModal").style.display = "none";
  if (isContinuousScanning) toggleContinuousScanningMode();
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

async function lookupSingleAwb() {
  const awb = document.getElementById("inputSingleAwb").value.trim();
  if (!awb) return alert("Please specify a valid AWB tracking number.");

  if (currentActionMode === "pickup") {
    const { data: existing } = await sb.from('dispatches_master').select('date').eq('awb_number', awb).maybeSingle();
    if (existing) {
      playHapticBeep("duplicate");
      return alert(`Duplicate Prevented: AWB ${awb} was already dispatched on ${existing.date}.`);
    }

    fetch(`${API_URL}?pin=${authenticatedPin}&action=previewAwb&awb=${encodeURIComponent(awb)}`)
      .then(r => r.json())
      .then(res => {
        if (!res.success) {
          playHapticBeep("error");
          alert("Verification Failed: " + res.error);
          cancelPreview();
        } else {
          playHapticBeep("success");
          pendingAwbData = res.data;
          const d = res.data;
          document.getElementById("previewContent").innerHTML = `
            <div style="font-size:13px; font-weight:800; color:var(--primary-accent); margin-bottom:4px;">✅ AWB Verified: ${d.awb}</div>
            <div style="font-size:12px;"><b>Order ID:</b> #${d.customer_order_number} (${d.warehouse_tag})</div>
            <div style="font-size:12px;"><b>Customer:</b> ${d.customer_name} (${d.phone})</div>
            <div style="font-size:12px;"><b>Destination:</b> ${d.city}, ${d.state}</div>
            <div style="font-size:12px;"><b>Invoice Amount:</b> ₹${d.total_amount} (${d.payment_mode})</div>
            <div style="font-size:11.5px; color:#475569; margin-top:4px;"><b>Products:</b> ${d.products_summary}</div>
          `;
          document.getElementById("previewCard").style.display = "block";
        }
      });
  } else {
    const { data: existing } = await sb.from('dispatches_master').select('*').eq('awb_number', awb).maybeSingle();
    const { data: staging } = await sb.from('incoming_reverse_pickups').select('*').eq('awb_number', awb).maybeSingle();

    if (!existing && !staging) {
      playHapticBeep("error");
      cancelPreview();
      return alert(`Action Blocked: AWB ${awb} not found in database records.`);
    }

    playHapticBeep("success");
    const item = existing || staging;
    pendingAwbData = item;
    pendingAwbData.is_staging_reverse = !existing && Boolean(staging);

    document.getElementById("previewContent").innerHTML = `
      <div style="font-size:13px; font-weight:800; color:var(--primary-accent); margin-bottom:4px;">✅ Matched Order: #${item.customer_order_number}</div>
      <div style="font-size:12px;"><b>Customer:</b> ${item.customer_name} (${item.city || '-'})</div>
      <div style="font-size:12px;"><b>Origin:</b> ${pendingAwbData.is_staging_reverse ? 'Delhivery Reverse Packet' : 'Standard Dispatched Order'}</div>
    `;
    document.getElementById("previewCard").style.display = "block";
  }
}

async function confirmSaveSingle() {
  if (!pendingAwbData) return;
  const d = pendingAwbData;
  const date = document.getElementById("selectedDate").value;
  const returnQc = document.getElementById("qcConditionSelect")?.value || "INTACT";

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
    if (d.is_staging_reverse) {
      const insRes = await sb.from('dispatches_master').insert([{
        date: date,
        awb_number: d.awb_number,
        customer_order_number: d.customer_order_number || "-",
        order_number: d.customer_order_number || "-",
        warehouse_tag: "DELHIVERY",
        customer_name: d.customer_name || "Customer Return",
        phone: d.phone || "",
        city: d.city || "",
        state: d.state || "",
        payment_mode: "RETURN",
        total_amount: parseFloat(d.total_amount || 0),
        products_summary: d.products_summary || "Reverse Logistics Packet",
        payment_status: "PENDING",
        gateway: "DELHIVERY_REVERSE",
        packed_status: "RTO_RECEIVED",
        current_stage: "RTO_RECEIVED",
        return_condition: returnQc
      }]);
      error = insRes.error;
      if (!error) await sb.from('incoming_reverse_pickups').delete().eq('awb_number', d.awb_number);
    } else {
      const res = await sb.from('dispatches_master')
        .update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED', return_condition: returnQc })
        .eq('awb_number', d.awb_number);
      error = res.error;
    }
  } else if (currentActionMode === "payment") {
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
    playHapticBeep("success");
    closeActionModal();
    loadDashboard();
  } else {
    playHapticBeep("error");
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
  if (lines.length === 0) return alert("Please specify valid AWB numbers.");

  for (const awb of lines) {
    try {
      if (currentActionMode === "pickup") {
        const preview = await fetch(`${API_URL}?pin=${authenticatedPin}&action=previewAwb&awb=${encodeURIComponent(awb)}`).then(r => r.json());
        if (preview.success) {
          const d = preview.data;
          await sb.from('dispatches_master').insert([{
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
            packed_status: "PICKED_UP",
            current_stage: "PICKED"
          }]);
        }
      } else if (currentActionMode === "return") {
        await sb.from('dispatches_master').update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' }).eq('awb_number', awb);
      } else if (currentActionMode === "payment") {
        const { data: existing } = await sb.from('dispatches_master').select('total_amount, payment_mode').eq('awb_number', awb).maybeSingle();
        if (existing) {
          await sb.from('dispatches_master').update({
            payment_status: 'RECEIVED',
            payment_received_amount: existing.total_amount,
            payment_received_date: date,
            gateway: (existing.payment_mode === 'COD') ? 'COD_CASH' : 'MANUAL_VERIFIED'
          }).eq('awb_number', awb);
        }
      }
    } catch (e) {}
  }

  playHapticBeep("success");
  closeActionModal();
  loadDashboard();
}

function startCamera() {
  if (!html5QrCode) html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 15, qrbox: { width: 280, height: 160 } },
    async decodedText => {
      const awb = decodedText.trim();
      if (!awb) return;

      // Point 2: Rapid-Fire Continuous Mode Execution
      if (isContinuousScanning && currentActionMode === "pickup") {
        const { data: existing } = await sb.from('dispatches_master').select('id').eq('awb_number', awb).maybeSingle();
        if (existing) {
          playHapticBeep("duplicate");
          return;
        }

        const preview = await fetch(`${API_URL}?pin=${authenticatedPin}&action=previewAwb&awb=${encodeURIComponent(awb)}`).then(r => r.json());
        if (preview.success) {
          const d = preview.data;
          const today = new Date().toISOString().slice(0, 10);
          await sb.from('dispatches_master').insert([{
            date: today,
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
            packed_status: "PICKED_UP",
            current_stage: "PICKED"
          }]);
          continuousSessionCount++;
          document.getElementById("rapidScanCounter").innerText = `(Session: ${continuousSessionCount})`;
          playHapticBeep("success");
        }
        return;
      }

      stopCamera();
      document.getElementById("inputSingleAwb").value = awb;

      if (currentActionMode === "return") {
        const { data: existing } = await sb.from('dispatches_master').select('*').eq('awb_number', awb).maybeSingle();
        const { data: staging } = await sb.from('incoming_reverse_pickups').select('*').eq('awb_number', awb).maybeSingle();

        if (!existing && !staging) {
          playHapticBeep("error");
          alert(`Scan Blocked: AWB ${awb} not located in records!`);
          switchInputMode('manual');
          return;
        }

        const match = existing || staging;
        const confirmed = confirm(`⚠️ Warning Confirmation:\n\nCamera detected AWB: ${awb}\nOrder: #${match.customer_order_number} (${match.customer_name})\n\nConfirm physical receipt as RTO RECEIVED?`);
        if (confirmed) {
          const today = new Date().toISOString().slice(0, 10);
          if (staging && !existing) {
            await sb.from('dispatches_master').insert([{
              date: today,
              awb_number: awb,
              customer_order_number: staging.customer_order_number || "-",
              warehouse_tag: "DELHIVERY",
              customer_name: staging.customer_name || "Customer Return",
              payment_mode: "RETURN",
              total_amount: staging.total_amount || 0,
              gateway: "DELHIVERY_REVERSE",
              packed_status: "RTO_RECEIVED",
              current_stage: "RTO_RECEIVED"
            }]);
            await sb.from('incoming_reverse_pickups').delete().eq('awb_number', awb);
          } else {
            await sb.from('dispatches_master').update({ packed_status: 'RTO_RECEIVED', current_stage: 'RTO_RECEIVED' }).eq('awb_number', awb);
          }

          playHapticBeep("success");
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
  const conf = confirm(`Security Confirmation:\n\nAre you sure you want to revert or delete AWB ${awb} from master database?`);
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
    playHapticBeep("success");
    loadDashboard();
  } else {
    playHapticBeep("error");
    alert("Revert Action Failed: " + error.message);
  }
}
