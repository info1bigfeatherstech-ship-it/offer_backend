/**
 * GST tax invoice view-model + HTML (India) — uses order snapshot + env seller details.
 * Not legal advice; configure STORE_* env for production seller identity.
 */

const roundMoney2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function normalizeState(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isInterState(sellerState, buyerState) {
  const a = normalizeState(sellerState);
  const b = normalizeState(buyerState);
  if (!a || !b) return false;
  return a !== b;
}

function splitGstAmount(totalTax, interstate) {
  const tax = roundMoney2(Number(totalTax) || 0);
  if (interstate || tax <= 0) {
    return { igst: tax, cgst: 0, sgst: 0 };
  }
  const half = roundMoney2(tax / 2);
  return { igst: 0, cgst: half, sgst: roundMoney2(tax - half) };
}

function lineFromItem(item, productName) {
  const qty = Number(item.quantity) || 0;
  const lineTotal = roundMoney2(Number(item.priceSnapshot?.total) || 0);
  const rate = item.gstRate != null ? Number(item.gstRate) : null;
  let taxable = lineTotal;
  let taxAmt = 0;
  if (rate != null && rate > 0 && rate < 100) {
    taxable = roundMoney2(lineTotal / (1 + rate / 100));
    taxAmt = roundMoney2(lineTotal - taxable);
  }
  return {
    description: productName || 'Goods',
    hsn: item.hsnCode || '—',
    qty,
    ratePercent: rate,
    taxableValue: taxable,
    taxAmount: taxAmt,
    total: lineTotal
  };
}

function buildGstInvoiceViewModel(order, populatedItems = []) {
  const seller = {
    legalName: String(process.env.STORE_LEGAL_NAME || process.env.STORE_NAME || 'Seller').trim(),
    gstin: String(process.env.STORE_GSTIN || '').trim() || null,
    address: String(process.env.STORE_ADDRESS || '').trim(),
    state: String(process.env.STORE_STATE || '').trim(),
    pincode: String(process.env.STORE_PINCODE || '').trim(),
    email: String(process.env.STORE_EMAIL || '').trim() || null,
    phone: String(process.env.STORE_PHONE || '').trim() || null
  };

  const snap = order.addressSnapshot || {};
  const buyer = {
    name: snap.fullName || 'Customer',
    address: [snap.addressLine1, snap.addressLine2, snap.area, snap.city, snap.state, snap.postalCode, snap.country]
      .filter(Boolean)
      .join(', '),
    state: snap.state || '',
    pincode: String(snap.postalCode || '').trim(),
    gstin: snap.gstin || snap.customerGstin || null,
    phone: snap.phone || null,
    email: snap.email || null
  };

  const interstate = isInterState(seller.state, buyer.state);

  const lines = (order.items || []).map((item, idx) => {
    const pname =
      populatedItems[idx]?.productId?.name ||
      (typeof item.productId === 'object' && item.productId?.name) ||
      'Product';
    return lineFromItem(item, pname);
  });

  const subtotal = roundMoney2(Number(order.subtotal) || 0);
  const discount = roundMoney2(Number(order.discount) || 0);
  const delivery = roundMoney2(Number(order.deliveryCharges) || 0);
  const taxTotal = roundMoney2(Number(order.tax) || 0);
  const grand = roundMoney2(Number(order.totalAmount) || 0);

  const lineTaxSum = roundMoney2(lines.reduce((s, l) => s + l.taxAmount, 0));
  const taxForSplit = lineTaxSum > 0.001 ? lineTaxSum : taxTotal;
  const gstParts = splitGstAmount(taxForSplit, interstate);

  const invNo = `INV-${order.orderId}`;
  const invDate = order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const si = order.shipmentInfo || {};
  const logistics = {
    awb: si.awbCode || si.trackingNumber || null,
    courier: si.courier || null
  };

  const sellerStateCode = String(process.env.STORE_STATE_CODE || stateCodeFromGstin(seller.gstin) || '').trim();
  const buyerStateCode =
    String(order.addressSnapshot?.stateCode || '').trim() ||
    stateCodeFromGstin(buyer.gstin) ||
    '';

  return {
    invoiceNumber: invNo,
    invoiceDate: invDate,
    invoiceDateDisplay: formatDateIndia(order.createdAt),
    orderDateDisplay: formatDateIndia(order.createdAt),
    orderId: order.orderId,
    placeOfSupply: buyer.state || '—',
    interstate,
    logistics,
    channel: String(order.channel || order.orderSource || 'CUSTOM').trim() || 'CUSTOM',
    remark: String(order.invoiceRemark || order.adminNote || order.notes || '').trim() || '—',
    seller,
    sellerStateCode: sellerStateCode || null,
    buyer,
    buyerStateCode: buyerStateCode || null,
    lines,
    summary: {
      subtotal,
      discount,
      deliveryCharges: delivery,
      taxableValue: roundMoney2(lines.reduce((s, l) => s + l.taxableValue, 0)),
      cgst: gstParts.cgst,
      sgst: gstParts.sgst,
      igst: gstParts.igst,
      totalTax: taxTotal,
      grandTotal: grand
    },
    payment: {
      method: order.paymentInfo?.method || '—',
      status: order.paymentStatus || '—'
    }
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** dd/mm/yyyy for invoice face (India). */
function formatDateIndia(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const y = d.getFullYear();
  return `${day}/${mo}/${y}`;
}

/** First 2 digits of GSTIN are state code when length >= 2. */
function stateCodeFromGstin(gstin) {
  const g = String(gstin || '').trim().toUpperCase();
  if (g.length >= 2 && /^\d{2}/.test(g)) return g.slice(0, 2);
  return '';
}

function buildGstInvoiceHtml(vm) {
  const shipLines = String(vm.buyer.address || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => escapeHtml(s))
    .join('<br/>');

  const soldLines = String(vm.seller.address || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => escapeHtml(s))
    .join('<br/>');

  const buyerStateLine = vm.buyerStateCode
    ? `State Code : ${escapeHtml(vm.buyerStateCode)}`
    : vm.buyer.state
      ? escapeHtml(vm.buyer.state)
      : '';
  const sellerStateLine = vm.sellerStateCode
    ? `State Code : ${escapeHtml(vm.sellerStateCode)}`
    : vm.seller.state
      ? escapeHtml(vm.seller.state)
      : '';

  const awbDisplay = vm.logistics?.awb ? escapeHtml(vm.logistics.awb) : '';
  const shippedBy = vm.logistics?.courier ? escapeHtml(vm.logistics.courier) : '';

  const gstHeader = vm.interstate ? 'IGST<br/><span class="subh">(Value | %)</span>' : 'GST<br/><span class="subh">(Value | %)</span>';

  const rows = vm.lines
    .map((l, idx) => {
      const unitPrice = l.qty > 0 ? roundMoney2(l.total / l.qty) : l.total;
      const rateStr = l.ratePercent != null && l.ratePercent > 0 ? String(l.ratePercent) : '0';
      const gstCell = `${l.taxAmount.toFixed(2)} | ${rateStr}`;
      return `<tr>
        <td class="c">${idx + 1}</td>
        <td>${escapeHtml(l.description)}</td>
        <td class="c">${escapeHtml(l.hsn)}</td>
        <td class="r">${l.qty}</td>
        <td class="r">Rs. ${unitPrice.toFixed(2)}</td>
        <td class="r">0.00</td>
        <td class="r">${l.taxableValue.toFixed(2)}</td>
        <td class="r">${gstCell}</td>
        <td class="r">${l.total.toFixed(2)}</td>
      </tr>`;
    })
    .join('');

  const del = vm.summary.deliveryCharges || 0;
  const shipRow =
    del > 0.001
      ? `<tr class="shiprow">
        <td class="c"></td>
        <td colspan="5"><strong>Shipping Charges</strong></td>
        <td class="r">${del.toFixed(2)}</td>
        <td class="r">0.00 | 0</td>
        <td class="r">${del.toFixed(2)}</td>
      </tr>`
      : '';

  const taxLabel = vm.interstate ? 'IGST' : 'CGST + SGST';
  const taxDetail = vm.interstate
    ? `IGST: Rs. ${vm.summary.igst.toFixed(2)}`
    : `CGST: Rs. ${vm.summary.cgst.toFixed(2)} · SGST: Rs. ${vm.summary.sgst.toFixed(2)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Tax Invoice ${escapeHtml(vm.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    @page { margin: 12mm; }
    body {
      margin: 0;
      padding: 16px 14px 28px;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      color: #111;
      background: #fff;
      line-height: 1.35;
    }
    .doc { max-width: 800px; margin: 0 auto; }
    .brand { font-size: 15px; font-weight: 700; text-align: center; margin-bottom: 2px; }
    .title { font-size: 13px; font-weight: 700; text-align: center; letter-spacing: 0.06em; margin-bottom: 12px; }
    .tri { width: 100%; border-collapse: collapse; border: 1px solid #000; margin-bottom: 10px; }
    .tri td { width: 33.33%; vertical-align: top; border: 1px solid #000; padding: 8px 10px; }
    .tri th { border: 1px solid #000; padding: 4px 8px; font-size: 10px; text-align: left; background: #f5f5f5; font-weight: 700; }
    .lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
    .inv-meta { font-size: 10px; line-height: 1.55; }
    .inv-meta div { margin-bottom: 2px; }
    .mono { font-family: Consolas, "Courier New", monospace; word-break: break-all; }
    table.items { width: 100%; border-collapse: collapse; border: 1px solid #000; margin-top: 8px; }
    table.items th, table.items td { border: 1px solid #000; padding: 5px 6px; font-size: 10px; }
    table.items th { background: #f0f0f0; font-weight: 700; text-align: center; vertical-align: bottom; }
    .c { text-align: center; }
    .r { text-align: right; font-variant-numeric: tabular-nums; }
    .subh { font-weight: 400; font-size: 9px; }
    tr.shiprow td { font-weight: 600; }
    .net { margin-top: 10px; font-size: 12px; font-weight: 700; text-align: right; }
    .foot { margin-top: 14px; font-size: 10px; border-top: 1px solid #000; padding-top: 8px; }
    .sign { margin-top: 28px; font-size: 10px; }
    .muted { color: #444; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <div class="doc">
    <div class="brand">${escapeHtml(vm.seller.legalName || 'Seller')}</div>
    <div class="title">TAX INVOICE</div>

    <table class="tri" cellspacing="0">
      <tr>
        <th>SHIPPING ADDRESS</th>
        <th>SOLD BY</th>
        <th>INVOICE DETAILS</th>
      </tr>
      <tr>
        <td>
          <div>${escapeHtml(vm.buyer.name)}</div>
          <div style="margin-top:6px">${shipLines}</div>
          ${buyerStateLine ? `<div style="margin-top:6px">${buyerStateLine}</div>` : ''}
          ${vm.buyer.phone ? `<div style="margin-top:4px">Ph: ${escapeHtml(vm.buyer.phone)}</div>` : ''}
        </td>
        <td>
          <div>${escapeHtml(vm.seller.legalName)}</div>
          <div style="margin-top:6px">${soldLines}</div>
          ${sellerStateLine ? `<div style="margin-top:6px">${sellerStateLine}</div>` : ''}
          ${vm.seller.gstin ? `<div style="margin-top:6px">GSTIN: ${escapeHtml(vm.seller.gstin)}</div>` : ''}
          ${vm.seller.phone ? `<div style="margin-top:4px">Ph: ${escapeHtml(vm.seller.phone)}</div>` : ''}
          ${vm.seller.email ? `<div style="margin-top:4px">Email: ${escapeHtml(vm.seller.email)}</div>` : ''}
        </td>
        <td>
          <div class="inv-meta">
            <div><strong>INVOICE NO.</strong> : ${escapeHtml(vm.invoiceNumber)}</div>
            <div><strong>INVOICE DATE</strong> : ${escapeHtml(vm.invoiceDateDisplay)}</div>
            <div><strong>ORDER NO.</strong> : <span class="mono">${escapeHtml(vm.orderId)}</span></div>
            <div><strong>ORDER DATE</strong> : ${escapeHtml(vm.orderDateDisplay)}</div>
            <div><strong>CHANNEL</strong> : ${escapeHtml(vm.channel)}</div>
            <div><strong>SHIPPED BY</strong> : ${shippedBy}</div>
            <div><strong>AWB NO.</strong> : ${awbDisplay}</div>
            <div><strong>PAYMENT METHOD</strong> : ${escapeHtml(String(vm.payment.method || '').toLowerCase())}</div>
            <div><strong>REMARK</strong> : ${escapeHtml(vm.remark)}</div>
          </div>
        </td>
      </tr>
    </table>

    <table class="items" cellspacing="0">
      <thead>
        <tr>
          <th style="width:28px">S.NO.</th>
          <th>PRODUCT NAME</th>
          <th style="width:52px">HSN</th>
          <th style="width:36px">QTY</th>
          <th style="width:72px">UNIT PRICE</th>
          <th style="width:64px">UNIT DISCOUNT</th>
          <th style="width:72px">TAXABLE<br/>VALUE</th>
          <th style="width:80px">${gstHeader}</th>
          <th style="width:88px">TOTAL<br/>(Incl. GST)</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        ${shipRow}
      </tbody>
    </table>

    <div class="net">NET TOTAL (In Value) Rs. ${vm.summary.grandTotal.toFixed(2)}</div>
    <div class="foot muted">
      <div><strong>Place of supply</strong>: ${escapeHtml(vm.placeOfSupply)} · <strong>${taxLabel}</strong> (${escapeHtml(taxDetail)})</div>
      <div style="margin-top:6px">Whether tax is payable under reverse charge — <strong>No</strong></div>
      <div style="margin-top:6px" class="muted">Computer-generated invoice. Amounts in INR.</div>
    </div>
    <div class="sign">
      <div><strong>Authorized signature for</strong></div>
      <div style="margin-top:4px">${escapeHtml(vm.seller.legalName || 'Seller')}</div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  buildGstInvoiceViewModel,
  buildGstInvoiceHtml
};
