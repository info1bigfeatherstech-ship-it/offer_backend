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

function resolveLineSku(item) {
  const prod = item?.productId;
  if (prod?.variants?.length && item.variantId) {
    const v = prod.variants.find((x) => String(x._id) === String(item.variantId));
    if (v?.sku) return String(v.sku).trim();
  }
  if (item?.sku) return String(item.sku).trim();
  return null;
}

function lineFromItem(item, productName) {
  const qty = Number(item.quantity) || 0;
  /** Pre-tax line amount — matches checkout `priceSnapshot.total` and order.subtotal. */
  const lineSubtotal = roundMoney2(Number(item.priceSnapshot?.total) || 0);
  const rate = item.gstRate != null ? Number(item.gstRate) : null;
  const taxable = lineSubtotal;
  let taxAmt = 0;
  if (rate != null && rate > 0 && rate < 100) {
    taxAmt = roundMoney2((lineSubtotal * rate) / 100);
  }
  const lineTotal = roundMoney2(taxable + taxAmt);
  const sku = resolveLineSku(item);
  const attrs = Array.isArray(item.variantAttributesSnapshot)
    ? item.variantAttributesSnapshot
        .map((a) => (a?.key && a?.value ? `${a.key}: ${a.value}` : null))
        .filter(Boolean)
        .join(', ')
    : '';
  return {
    description: productName || 'Goods',
    sku,
    attrs,
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
  const buyerAddressLines = [
    snap.addressLine1,
    snap.addressLine2,
    snap.area,
    [snap.city, snap.postalCode].filter(Boolean).join(' '),
    snap.state,
    snap.country
  ].filter(Boolean);
  const buyer = {
    name: snap.fullName || 'Customer',
    address: buyerAddressLines.join(', '),
    addressLines: buyerAddressLines,
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
  const itemsTaxable = roundMoney2(lines.reduce((s, l) => s + l.taxableValue, 0));
  const itemsTotalWithTax = roundMoney2(lines.reduce((s, l) => s + l.total, 0));
  /** Prefer persisted order.tax (checkout source of truth); fall back to per-line sum. */
  const taxForSplit = taxTotal > 0.001 ? taxTotal : lineTaxSum;
  const gstParts = splitGstAmount(taxForSplit, interstate);
  const computedGrand = roundMoney2(subtotal + taxTotal + delivery - discount);

  const invNo = `INV-${order.orderId}`;
  const invDate = order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const si = order.shipmentInfo || {};
  const shipSnap = order.shippingSnapshot || {};
  const logistics = {
    awb: si.awbCode || si.trackingNumber || null,
    /** Assigned name after AWB; else checkout-quoted courier (what customer paid for). */
    courier: si.courier || shipSnap.courierName || null
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
      itemsTaxable,
      itemsTotalWithTax,
      taxableValue: roundMoney2(itemsTaxable + delivery),
      cgst: gstParts.cgst,
      sgst: gstParts.sgst,
      igst: gstParts.igst,
      totalTax: taxForSplit,
      grandTotal: grand,
      computedGrand
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

function formatRs(amount) {
  return `Rs.${roundMoney2(Number(amount) || 0).toFixed(2)}`;
}

/** Numeric amount only (no Rs. prefix) for summary rows. */
function formatAmount(amount) {
  return roundMoney2(Number(amount) || 0).toFixed(2);
}

/** Title-style brand name — e.g. "offer wale baba" → "Offer Wale Baba". */
function formatBrandDisplayName(name) {
  return String(name || 'Seller')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function addressLinesHtml(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split(',');
  return arr
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .map((s) => escapeHtml(s))
    .join('<br/>');
}

function gstTaxCell(line, interstate) {
  const rateStr =
    line.ratePercent != null && line.ratePercent > 0 ? `${Number(line.ratePercent)}%` : '0%';
  if (interstate) {
    return `${line.taxAmount.toFixed(2)}<br/><span class="tiny">@${rateStr}</span>`;
  }
  const half = roundMoney2(line.taxAmount / 2);
  return `C ${half.toFixed(2)}<br/>S ${roundMoney2(line.taxAmount - half).toFixed(2)}<br/><span class="tiny">@${rateStr}</span>`;
}

function buildGstInvoiceHtml(vm) {
  const brandName = formatBrandDisplayName(vm.seller.legalName || 'Offer Wale Baba');
  const buyerLines = addressLinesHtml(vm.buyer.addressLines || vm.buyer.address);
  const sellerLines = addressLinesHtml(
    String(vm.seller.address || '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const buyerStateCodeHtml = vm.buyerStateCode
    ? `<div class="kv"><strong>State Code:</strong> ${escapeHtml(vm.buyerStateCode)}</div>`
    : '';
  const sellerStateCodeHtml = vm.sellerStateCode
    ? `<div class="kv"><strong>State Code:</strong> ${escapeHtml(vm.sellerStateCode)}</div>`
    : '';
  const placeOfSupplyHtml = vm.placeOfSupply
    ? `<div class="kv"><strong>Place of Supply:</strong> ${escapeHtml(vm.placeOfSupply)}</div>`
    : '';

  const awbDisplay = vm.logistics?.awb ? escapeHtml(vm.logistics.awb) : '—';
  const shippedBy = vm.logistics?.courier ? escapeHtml(vm.logistics.courier) : '—';
  const payMethod = escapeHtml(String(vm.payment.method || '—').toUpperCase());
  const taxColHeader = vm.interstate ? 'IGST' : 'CGST/SGST';

  const rows = vm.lines
    .map((l, idx) => {
      const descParts = [escapeHtml(l.description)];
      if (l.sku) descParts.push(`<span class="sku"><strong>SKU:</strong> ${escapeHtml(l.sku)}</span>`);
      if (l.attrs) descParts.push(`<span class="sku">${escapeHtml(l.attrs)}</span>`);
      return `<tr>
        <td class="c col-srno">${idx + 1}</td>
        <td class="desc">${descParts.join('<br/>')}</td>
        <td class="c">${escapeHtml(l.hsn)}</td>
        <td class="c">${l.qty}</td>
        <td class="r col-taxable">${l.taxableValue.toFixed(2)}</td>
        <td class="r gst col-gst">${gstTaxCell(l, vm.interstate)}</td>
        <td class="r"><strong>${l.total.toFixed(2)}</strong></td>
      </tr>`;
    })
    .join('');

  const del = vm.summary.deliveryCharges || 0;
  const shipRow =
    del > 0.001
      ? `<tr class="alt">
        <td class="c col-srno">+</td>
        <td colspan="3"><strong>Shipping / Other charges</strong></td>
        <td class="r col-taxable">${del.toFixed(2)}</td>
        <td class="r col-gst">—</td>
        <td class="r"><strong>${del.toFixed(2)}</strong></td>
      </tr>`
      : '';

  const discountRow =
    vm.summary.discount > 0.001
      ? `<tr class="alt">
        <td class="c col-srno">−</td>
        <td colspan="3"><strong>Discount</strong></td>
        <td class="r col-taxable">−${vm.summary.discount.toFixed(2)}</td>
        <td class="r col-gst">—</td>
        <td class="r"><strong>−${vm.summary.discount.toFixed(2)}</strong></td>
      </tr>`
      : '';

  const taxSummary = vm.interstate
    ? `IGST ${formatAmount(vm.summary.igst)}`
    : `CGST ${formatAmount(vm.summary.cgst)} + SGST ${formatAmount(vm.summary.sgst)}`;

  const discountTotalsRow =
    vm.summary.discount > 0.001
      ? `<div class="row"><span class="row-label">Discount</span><span class="row-val">−${formatAmount(vm.summary.discount)}</span></div>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Tax Invoice ${escapeHtml(vm.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    @page {
      size: A4 portrait;
      margin: 10mm 12mm;
    }
    body {
      margin: 0 auto;
      padding: 0;
      width: 100%;
      max-width: 186mm;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      color: #000;
      background: #fff;
      line-height: 1.35;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .doc { width: 100%; }
    .head {
      text-align: center;
      border-bottom: 2px solid #000;
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .brand, .title, .amount-payable-label {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .brand { line-height: 1.3; margin-bottom: 6px; text-align: center; width: 100%; }
    .title-wrap { position: relative; margin-top: 6px; min-height: 22px; }
    .title { text-align: center; width: 100%; }
    .copy {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      font-size: 10px;
      font-weight: 400;
      text-align: right;
      white-space: nowrap;
      line-height: 1.2;
    }
    .pair { width: 100%; border-collapse: collapse; border: 1px solid #000; margin-bottom: 10px; }
    .pair td { width: 50%; vertical-align: top; border: 1px solid #000; padding: 8px 10px; font-size: 10px; font-weight: 400; }
    .lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; margin-bottom: 5px; letter-spacing: 0.03em; }
    .addr-name { font-weight: 600; margin-bottom: 3px; }
    .addr-lines { margin-top: 3px; line-height: 1.4; }
    .kv { margin-top: 5px; font-weight: 400; font-size: 10px; }
    .kv strong { font-weight: 700; }
    .meta { width: 100%; border-collapse: collapse; border: 1px solid #000; margin-bottom: 10px; font-size: 10px; }
    .meta td { border: 1px solid #000; padding: 6px 8px; vertical-align: top; width: 50%; }
    .meta strong { font-weight: 700; }
    .mono { font-family: Consolas, "Courier New", monospace; font-size: 9px; word-break: break-all; }
    table.items { width: 100%; border-collapse: collapse; border: 1px solid #000; table-layout: fixed; }
    table.items th, table.items td {
      border: 1px solid #000;
      padding: 6px 5px;
      font-size: 10px;
      vertical-align: top;
      word-wrap: break-word;
    }
    table.items th { background: #f2f2f2; font-weight: 700; text-align: center; white-space: nowrap; }
    table.items th.col-taxable,
    table.items td.col-taxable {
      width: 12%;
      white-space: nowrap;
      word-wrap: normal;
    }
    table.items th.col-gst,
    table.items td.col-gst { width: 13%; }
    table.items th.col-srno,
    table.items td.col-srno {
      width: 5%;
      max-width: 5%;
      white-space: nowrap;
      overflow: hidden;
      padding: 6px 3px;
      font-size: 10px;
      line-height: 1.2;
      text-align: center;
    }
    .c { text-align: center; }
    .r { text-align: right; font-variant-numeric: tabular-nums; }
    .desc { text-align: left; }
    .sku { display: block; font-size: 9px; color: #333; margin-top: 2px; }
    .tiny { font-size: 8px; color: #444; }
    tr.alt td { background: #fafafa; }
    .totals-wrap { margin-top: 10px; display: flex; justify-content: flex-end; }
    .totals {
      width: 100%;
      max-width: 320px;
      border: 1px solid #000;
      padding: 10px 12px;
    }
    .amount-payable {
      display: flex;
      justify-content: flex-end;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid #ccc;
    }
    .amount-payable-label { text-align: right; }
    .amount-payable-amt { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .totals .row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-top: 4px;
    }
    .totals .row-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-align: left;
      flex: 0 1 auto;
    }
    .totals .row-val {
      font-size: 10px;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
      text-align: right;
      flex: 0 0 auto;
      margin-left: auto;
    }
    .foot { margin-top: 12px; font-size: 9px; line-height: 1.45; color: #222; }
    .sign {
      margin-top: 20px;
      border-top: 1px dashed #000;
      padding-top:60px;
      padding-bottom: 8px;
      text-align: right;
    }
    .sign-brand {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      line-height: 1.2;
      margin-bottom: 4px;
    }
    .sign-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1.2;
    }
    @media screen {
      body {
        padding: 12mm 10mm;
        box-shadow: 0 0 0 1px #ccc;
        margin: 12px auto;
        min-height: 297mm;
      }
    }
    @media print {
      body { padding: 0; max-width: none; box-shadow: none; }
      .doc { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="doc">
    <div class="head">
      <div class="brand">${escapeHtml(brandName)}</div>
      <div class="title-wrap">
        <div class="title">TAX INVOICE</div>
        <div class="copy">Original For Recipient</div>
      </div>
    </div>

    <table class="pair" cellspacing="0">
      <tr>
        <td>
          <div class="lbl">Bill To / Ship To</div>
          <div class="addr-name">${escapeHtml(vm.buyer.name)}</div>
          <div class="addr-lines">${buyerLines}</div>
          ${placeOfSupplyHtml}
          ${buyerStateCodeHtml}
          ${vm.buyer.phone ? `<div class="kv"><strong>Phone:</strong> ${escapeHtml(vm.buyer.phone)}</div>` : ''}
        </td>
        <td>
          <div class="lbl">Sold By</div>
          <div class="addr-name">${escapeHtml(vm.seller.legalName)}</div>
          <div class="addr-lines">${sellerLines}</div>
          ${sellerStateCodeHtml}
          ${vm.seller.gstin ? `<div class="kv"><strong>GSTIN:</strong> ${escapeHtml(vm.seller.gstin)}</div>` : ''}
          ${vm.seller.phone ? `<div class="kv"><strong>Phone:</strong> ${escapeHtml(vm.seller.phone)}</div>` : ''}
        </td>
      </tr>
    </table>

    <table class="meta" cellspacing="0">
      <tr>
        <td><strong>Order No.</strong><br/><span class="mono">${escapeHtml(vm.orderId)}</span></td>
        <td><strong>Invoice No.</strong><br/><span class="mono">${escapeHtml(vm.invoiceNumber)}</span></td>
      </tr>
      <tr>
        <td><strong>Order Date</strong><br/>${escapeHtml(vm.orderDateDisplay)}</td>
        <td><strong>Invoice Date</strong><br/>${escapeHtml(vm.invoiceDateDisplay)}</td>
      </tr>
      <tr>
        <td><strong>Payment</strong><br/>${payMethod}</td>
        <td><strong>Channel</strong><br/>${escapeHtml(vm.channel)}</td>
      </tr>
      <tr>
        <td><strong>Shipped By</strong><br/>${shippedBy}</td>
        <td><strong>AWB No.</strong><br/><span class="mono">${awbDisplay}</span></td>
      </tr>
    </table>

    <table class="items" cellspacing="0">
      <colgroup>
        <col style="width:5%"/>
        <col style="width:38%"/>
        <col style="width:10%"/>
        <col style="width:7%"/>
        <col style="width:12%"/>
        <col style="width:13%"/>
        <col style="width:15%"/>
      </colgroup>
      <thead>
        <tr>
          <th class="col-srno">Sr.No.</th>
          <th>Description</th>
          <th>HSN</th>
          <th>Qty</th>
          <th class="col-taxable">Taxable</th>
          <th class="col-gst">${taxColHeader}</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        ${discountRow}
        ${shipRow}
      </tbody>
    </table>

    <div class="totals-wrap">
      <div class="totals">
      <div class="amount-payable">
        <span class="amount-payable-label title">Amount Payable</span>
        <span class="amount-payable-amt">Rs.&nbsp;${formatAmount(vm.summary.grandTotal)}</span>
      </div>
      <div class="row"><span class="row-label">Sub Total</span><span class="row-val">${formatAmount(vm.summary.subtotal)}</span></div>
      <div class="row"><span class="row-label">Tax</span><span class="row-val">${formatAmount(vm.summary.totalTax)}</span></div>
      <div class="row"><span class="row-label">Delivery</span><span class="row-val">${formatAmount(vm.summary.deliveryCharges)}</span></div>
      ${discountTotalsRow}
      <div class="row"><span class="row-label">Place of Supply</span><span class="row-val">${escapeHtml(vm.placeOfSupply)}</span></div>
      <div class="row"><span class="row-label">Tax Split</span><span class="row-val">${escapeHtml(taxSummary)}</span></div>
      </div>
    </div>

    <div class="foot">
      Whether tax is payable under reverse charge — <strong>No</strong>.
      This is a computer-generated tax invoice and does not require a physical signature.
      Amounts are in INR. Logistics documents from the carrier are separate from this GST invoice.
    </div>

    <div class="sign">
      <div class="sign-brand">${escapeHtml(brandName)}</div>
      <div class="sign-label"><strong>Authorized Signatory</strong></div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  buildGstInvoiceViewModel,
  buildGstInvoiceHtml
};
