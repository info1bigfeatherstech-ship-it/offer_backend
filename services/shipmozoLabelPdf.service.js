/**
 * Render Shipmozo 4×6 shipping label as PDF (288×432 pt) and preview HTML.
 * Visual layout matches Shiprocket standard label: stacked bands, not cramped cells.
 */

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { formatInr } = require('./shipmozoLabelViewModel.service');
const logger = require('../utils/logger');

const PAGE_W = 4 * 72;
const PAGE_H = 6 * 72;
const MARGIN = 7;

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function barcodePng(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return await bwipjs.toBuffer({
      bcid: 'code128',
      text: value,
      scale: 3,
      height: 14,
      includetext: false,
      backgroundcolor: 'FFFFFF'
    });
  } catch (err) {
    logger.warn('barcodePng failed', { message: err?.message });
    return null;
  }
}

function barcodeSvgMarkup(text, className) {
  const value = String(text || '').trim();
  if (!value) return '';
  try {
    const svg = bwipjs.toSVG({
      bcid: 'code128',
      text: value,
      scale: 3,
      height: 12,
      includetext: false,
      paddingwidth: 2,
      paddingheight: 1
    });
    return `<div class="${className}">${svg}</div>`;
  } catch (err) {
    logger.warn('barcodeSvgMarkup failed', { message: err?.message });
    return '';
  }
}

function strokeRect(doc, x, y, w, h) {
  doc.save();
  doc.lineWidth(0.8).strokeColor('#111111').rect(x, y, w, h).stroke();
  doc.restore();
}

function hLine(doc, x, y, w) {
  doc.save();
  doc.lineWidth(0.7).strokeColor('#111111').moveTo(x, y).lineTo(x + w, y).stroke();
  doc.restore();
}

function txt(doc, text, x, y, w, opts = {}) {
  const fontSize = opts.fontSize || 7;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor('#111111');
  doc.text(String(text == null ? '' : text), x, y, {
    width: w,
    height: opts.height || 11,
    ellipsis: true,
    lineBreak: opts.wrap !== false,
    align: opts.align || 'left'
  });
}

function fitOneLine(doc, text, x, y, w, opts = {}) {
  const raw = String(text == null ? '' : text);
  let size = opts.fontSize || 8;
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111111');
  while (size > 5.5) {
    doc.fontSize(size);
    if (doc.widthOfString(raw) <= w) break;
    size -= 0.35;
  }
  txt(doc, raw, x, y, w, { ...opts, fontSize: size, wrap: false });
}

function metaLines(vm, s) {
  const lines = [`Dimensions: ${vm.dimensionText}`];
  if (s.delivery.showPaymentMode) lines.push(`Payment: ${vm.paymentMode}`);
  if (s.misc.showOrderTotal) lines.push(`Order Total: ${formatInr(vm.orderTotal)}`);
  lines.push(`Weight: ${vm.weightText}`);
  if (s.misc.showEwayBill) lines.push(`EWaybill No: ${vm.ewayBill || '—'}`);
  if (s.delivery.showRoutingCode && vm.routingCode) lines.push(`Routing code: ${vm.routingCode}`);
  if (s.delivery.showRtoRoutingCode && vm.rtoRoutingCode) {
    lines.push(`RTO Routing code: ${vm.rtoRoutingCode}`);
  }
  return lines;
}

async function renderLabelPdf(vm) {
  const s = vm.settings || {};
  const innerW = PAGE_W - MARGIN * 2;
  const chunks = [];
  const awbBar = s.delivery?.showAwbBarcode ? await barcodePng(vm.awb) : null;
  const orderBar = s.delivery?.showOrderBarcode ? await barcodePng(vm.orderId) : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    try {
      const doc = new PDFDocument({
        size: [PAGE_W, PAGE_H],
        margin: 0,
        autoFirstPage: true,
        info: { Title: `Shipmozo label ${vm.orderId || vm.awb || ''}`.trim() }
      });
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      doc.on('error', fail);

      const x0 = MARGIN;
      let y = MARGIN;
      const pageInnerH = PAGE_H - MARGIN * 2;
      strokeRect(doc, x0, y, innerW, pageInnerH);

      const shipH = 72;
      txt(doc, 'Ship To', x0 + 6, y + 5, innerW - 12, { fontSize: 8, bold: true, height: 12 });
      if (s.delivery?.showCustomerAddress) {
        txt(doc, vm.shipToName, x0 + 6, y + 18, innerW - 12, { fontSize: 10, bold: true, height: 13 });
        txt(doc, (vm.shipToLines || []).join('\n'), x0 + 6, y + 32, innerW - 12, {
          fontSize: 7.5,
          wrap: true,
          height: 34
        });
      }
      if (s.delivery?.showCustomerPhone && vm.shipToPhone) {
        txt(doc, `Ph: ${vm.shipToPhone}`, x0 + 6, y + shipH - 12, innerW - 12, { fontSize: 7, height: 10 });
      }
      hLine(doc, x0, y + shipH, innerW);
      y += shipH;

      const band2 = 118;
      const rightW = Math.round(innerW * 0.46);
      const leftW = innerW - rightW;
      const metas = metaLines(vm, s);
      let my = y + 6;
      metas.forEach((line) => {
        txt(doc, line, x0 + 6, my, leftW - 10, { fontSize: 7.5, height: 12, wrap: false });
        my += 13;
      });
      txt(doc, vm.courier || 'SHIPMOZO', x0 + leftW + 4, y + 5, rightW - 8, {
        fontSize: 9,
        bold: true,
        align: 'center',
        height: 12
      });
      const shipmozoId = String(vm.shipmozoId || '').trim();
      const awbId = String(vm.awb || '').trim();
      if (s.delivery?.showAwbBarcode) {
        const barH = 50;
        let cursorY = y + 18;
        if (shipmozoId) {
          fitOneLine(doc, `Shipmozo ID: ${shipmozoId}`, x0 + leftW + 3, cursorY, rightW - 6, {
            fontSize: 7,
            bold: true,
            align: 'center',
            height: 11
          });
          cursorY += 12;
        }
        if (awbBar) {
          try {
            doc.image(awbBar, x0 + leftW + 6, cursorY, { width: rightW - 12, height: barH });
          } catch (imgErr) {
            logger.warn('AWB barcode image failed', { message: imgErr?.message });
          }
          cursorY += barH + 2;
        }
        if (awbId) {
          fitOneLine(doc, `AWB: ${awbId}`, x0 + leftW + 3, Math.min(cursorY, y + band2 - 13), rightW - 6, {
            fontSize: 7.5,
            bold: true,
            align: 'center',
            height: 11
          });
        }
      }
      hLine(doc, x0, y + band2, innerW);
      y += band2;

      const band3 = 96;
      const shipW = Math.round(innerW * 0.5);
      txt(doc, 'Shipped By (if undelivered, return to)', x0 + 6, y + 5, shipW - 10, {
        fontSize: 6.5,
        bold: true,
        height: 10
      });
      if ((s.pickup?.showPickupName || s.pickup?.showRtoName) && vm.pickup?.name) {
        txt(doc, vm.pickup.name, x0 + 6, y + 16, shipW - 10, { fontSize: 6.5, height: 10 });
      }
      if (s.pickup?.showPickupAddress || s.pickup?.showRtoAddress) {
        txt(doc, (vm.pickup?.lines || []).join('\n'), x0 + 6, y + 29, shipW - 10, {
          fontSize: 7,
          wrap: true,
          height: 36
        });
      }
      let supportY = y + 68;
      if (s.pickup?.showPickupPhone && vm.pickup?.phone) {
        txt(doc, `Ph: ${vm.pickup.phone}`, x0 + 6, supportY, shipW - 10, { fontSize: 6.5, height: 10 });
        supportY += 10;
      }
      if (s.support?.showCustomerSupport) {
        const support = [vm.supportEmail, vm.supportMobile].filter(Boolean).join('  ');
        if (support) {
          txt(doc, `Customer Care: ${support}`, x0 + 6, Math.min(supportY, y + band3 - 12), shipW - 10, {
            fontSize: 6.5,
            height: 10
          });
        }
      }
      if (s.pickup?.showGstin && vm.gstin) {
        txt(doc, `GSTIN: ${vm.gstin}`, x0 + 6, y + band3 - 12, shipW - 10, { fontSize: 6.5, height: 10 });
      }

      fitOneLine(doc, `Order#: ${vm.orderId || ''}`, x0 + shipW + 4, y + 5, innerW - shipW - 8, {
        fontSize: 8,
        bold: true,
        align: 'center',
        height: 12
      });
      if (orderBar) {
        try {
          doc.image(orderBar, x0 + shipW + 6, y + 18, { width: innerW - shipW - 12, height: 42 });
        } catch (imgErr) {
          logger.warn('Order barcode image failed', { message: imgErr?.message });
        }
      }
      const inv = [];
      if (s.misc?.showInvoiceNumber && vm.invoiceNo) inv.push(`Invoice No: ${vm.invoiceNo}`);
      if (s.misc?.showInvoiceDate && vm.invoiceDate) inv.push(`Invoice Date: ${vm.invoiceDate}`);
      if (s.misc?.showOrderDate && vm.orderDate) inv.push(`Order Date: ${vm.orderDate}`);
      txt(doc, inv.join('\n'), x0 + shipW + 6, y + 62, innerW - shipW - 12, {
        fontSize: 6.5,
        wrap: true,
        height: 30
      });
      hLine(doc, x0, y + band3, innerW);
      y += band3;

      const p = s.products || {};
      const cols = [];
      if (p.showItem) cols.push({ key: 'name', title: 'Item', w: 0.34 });
      if (p.showSku) cols.push({ key: 'sku', title: 'SKU', w: 0.16 });
      if (p.showQty) cols.push({ key: 'qty', title: 'Qty', w: 0.1 });
      if (p.showPrice) cols.push({ key: 'price', title: 'Price', w: 0.2 });
      if (p.showTotal) cols.push({ key: 'total', title: 'Total', w: 0.2 });
      if (p.showHsn) cols.push({ key: 'hsn', title: 'HSN', w: 0.12 });
      const colSum = cols.reduce((a, c) => a + c.w, 0) || 1;
      cols.forEach((c) => {
        c.px = (c.w / colSum) * innerW;
      });

      const rowH = 12;
      const headerH = 14;
      const lineCount = Math.max(1, (vm.lines || []).length);
      const footerH = 18;
      const tableH = Math.min(
        PAGE_H - MARGIN - y - 52,
        headerH + lineCount * rowH + (vm.hiddenCount > 0 ? 10 : 0) + footerH
      );
      let cx = x0;
      cols.forEach((c) => {
        txt(doc, c.title, cx + 4, y + 2, c.px - 6, { fontSize: 7, bold: true, height: 11 });
        cx += c.px;
      });
      hLine(doc, x0, y + headerH, innerW);
      let ry = y + headerH + 2;
      (vm.lines || []).forEach((line) => {
        cx = x0;
        cols.forEach((c) => {
          let val = line[c.key];
          if (c.key === 'price' || c.key === 'total') val = formatInr(val);
          txt(doc, val, cx + 4, ry, c.px - 6, { fontSize: 7, height: 11, wrap: false });
          cx += c.px;
        });
        ry += rowH;
      });
      if (vm.hiddenCount > 0) {
        txt(doc, `+${vm.hiddenCount} more item(s)`, x0 + 4, ry, innerW - 8, { fontSize: 6.5, height: 10 });
        ry += 10;
      }
      hLine(doc, x0, y + tableH - footerH, innerW);
      const leftFoot = p.showShippingCharges ? `Shipping Charges: ${formatInr(vm.shippingCharges)}` : '';
      const rightFoot = [
        p.showTotalQuantity ? `Total Quantity: ${vm.totalQty}` : '',
        p.showCollectableAmount ? `Collectable Amount: ${formatInr(vm.collectable)}` : ''
      ]
        .filter(Boolean)
        .join('   ');
      txt(doc, leftFoot, x0 + 4, y + tableH - 14, innerW * 0.42, { fontSize: 7, height: 11 });
      txt(doc, rightFoot, x0 + innerW * 0.4, y + tableH - 14, innerW * 0.58 - 6, {
        fontSize: 7.5,
        bold: true,
        align: 'right',
        height: 11
      });
      hLine(doc, x0, y + tableH, innerW);
      y += tableH;

      const rest = PAGE_H - MARGIN - y;
      if (rest > 14 && s.misc?.showNotes && s.misc.notes) {
        txt(doc, s.misc.notes, x0 + 6, y + 4, innerW - 12, {
          fontSize: 6.5,
          wrap: true,
          height: Math.max(16, rest - 22)
        });
      }
      if (s.misc?.showAutoGeneratedDisclaimer) {
        txt(
          doc,
          'This is an auto generated label and does not require any signature.',
          x0 + 6,
          PAGE_H - MARGIN - 14,
          innerW - 100,
          { fontSize: 5.5, height: 10 }
        );
      }
      if (s.misc?.showPoweredBy) {
        txt(doc, `Powered By ${vm.poweredBy || 'OfferWale Baba'}`, x0 + innerW - 108, PAGE_H - MARGIN - 14, 102, {
          fontSize: 5.5,
          align: 'right',
          height: 10
        });
      }

      doc.end();
    } catch (err) {
      fail(err);
    }
  });
}

async function renderLabelHtml(vm) {
  const s = vm.settings || {};
  const p = s.products || {};
  const awbBar =
    s.delivery?.showAwbBarcode && vm.awb ? barcodeSvgMarkup(vm.awb, 'bc-awb') : '';
  const orderBar =
    s.delivery?.showOrderBarcode && vm.orderId ? barcodeSvgMarkup(vm.orderId, 'bc-ord') : '';
  const addr = (vm.shipToLines || []).map(escapeHtml).join('<br/>');
  const pickup = (vm.pickup?.lines || []).map(escapeHtml).join('<br/>');
  const support = [vm.supportEmail, vm.supportMobile].filter(Boolean).join('  ');
  const metas = metaLines(vm, s)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');
  const heads = [];
  if (p.showItem) heads.push('<th>Item</th>');
  if (p.showSku) heads.push('<th>SKU</th>');
  if (p.showQty) heads.push('<th>Qty</th>');
  if (p.showPrice) heads.push('<th>Price</th>');
  if (p.showTotal) heads.push('<th>Total</th>');
  if (p.showHsn) heads.push('<th>HSN</th>');
  const rows = (vm.lines || [])
    .map((line) => {
      const cells = [];
      if (p.showItem) cells.push(`<td>${escapeHtml(line.name)}</td>`);
      if (p.showSku) cells.push(`<td>${escapeHtml(line.sku)}</td>`);
      if (p.showQty) cells.push(`<td class="c">${escapeHtml(line.qty)}</td>`);
      if (p.showPrice) cells.push(`<td>${escapeHtml(formatInr(line.price))}</td>`);
      if (p.showTotal) cells.push(`<td>${escapeHtml(formatInr(line.total))}</td>`);
      if (p.showHsn) cells.push(`<td>${escapeHtml(line.hsn)}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: #fff; overflow: hidden;
  }
  .sheet {
    width: 100%; height: 100%;
    border: 1.5px solid #111;
    font-family: Arial, Helvetica, sans-serif;
    color: #111; font-size: 10.5px; line-height: 1.35;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .pad { padding: 7px 9px; }
  .rule { border-bottom: 1px solid #111; }
  .split { display: flex; min-height: 0; }
  .left { flex: 1 1 auto; min-width: 0; padding: 7px 9px; }
  .right { flex: 0 0 46%; width: 46%; padding: 6px 7px 5px; text-align: center; min-width: 0;
    display: flex; flex-direction: column; align-items: center; }
  .right.order { flex-basis: 50%; width: 50%; }
  .b { font-weight: 700; }
  .h { font-size: 11.5px; }
  .tiny { font-size: 8.5px; line-height: 1.3; }
  .ship-name { font-size: 9px; font-weight: 500; margin-top: 2px; }
  .id-line, .awb-line, .order-line {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 100%; font-weight: 700;
  }
  .id-line { font-size: 8.5px; margin-top: 4px; }
  .awb-line { font-size: 9px; margin-top: 3px; }
  .order-line { font-size: 9.5px; }
  .awb-block { width: 100%; margin-top: 2px; }
  .meta div { font-size: 10.5px; }
  .bc-awb { width: 100%; height: 46px; margin-top: 3px; }
  .bc-ord { width: 100%; height: 44px; margin: 5px 0 4px; }
  .bc-awb svg, .bc-ord svg { width: 100%; height: 100%; display: block; }
  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9.5px; }
  table.items th, table.items td {
    padding: 3px 6px; text-align: left; border-bottom: 1px solid #ccc;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  table.items th { border-bottom: 1px solid #111; }
  .c { text-align: center; }
  .totals {
    display: flex; justify-content: space-between; gap: 8px;
    padding: 5px 9px; font-size: 10.5px; border-top: 1px solid #111;
  }
  .notes {
    margin: 6px 8px 0; padding: 5px 7px;
    border: 1px solid #111; font-size: 8.5px; line-height: 1.3;
  }
  .foot { margin-top: auto; padding: 6px 9px 7px; font-size: 8px; }
  .foot-row { display: flex; justify-content: space-between; gap: 8px; }
  @media print {
    @page { size: 4in 6in; margin: 0; }
    html, body { width: 4in; height: 6in; overflow: hidden; }
    .sheet { width: 4in; height: 6in; }
  }
</style></head>
<body>
<div class="sheet">
  <div class="pad rule">
    <div class="b">Ship To</div>
    ${
      s.delivery?.showCustomerAddress
        ? `<div class="b h" style="margin-top:2px">${escapeHtml(vm.shipToName)}</div><div>${addr}</div>`
        : ''
    }
    ${s.delivery?.showCustomerPhone && vm.shipToPhone ? `<div>Ph: ${escapeHtml(vm.shipToPhone)}</div>` : ''}
  </div>
  <div class="split rule">
    <div class="left meta">${metas}</div>
    <div class="right">
      <div class="b h">${escapeHtml(vm.courier || 'SHIPMOZO')}</div>
      ${
        s.delivery?.showAwbBarcode
          ? `<div class="awb-block">
              ${vm.shipmozoId ? `<div class="id-line">${escapeHtml(`Shipmozo ID: ${vm.shipmozoId}`)}</div>` : ''}
              ${awbBar}
              ${vm.awb ? `<div class="awb-line">${escapeHtml(`AWB: ${vm.awb}`)}</div>` : ''}
            </div>`
          : ''
      }
    </div>
  </div>
  <div class="split rule">
    <div class="left">
      <div class="tiny b">Shipped By (if undelivered, return to)</div>
      ${
        (s.pickup?.showPickupName || s.pickup?.showRtoName) && vm.pickup?.name
          ? `<div class="ship-name">${escapeHtml(vm.pickup.name)}</div>`
          : ''
      }
      ${(s.pickup?.showPickupAddress || s.pickup?.showRtoAddress) ? `<div>${pickup}</div>` : ''}
      ${s.pickup?.showPickupPhone && vm.pickup?.phone ? `<div>Ph: ${escapeHtml(vm.pickup.phone)}</div>` : ''}
      ${s.support?.showCustomerSupport && support ? `<div class="tiny">Customer Care: ${escapeHtml(support)}</div>` : ''}
      ${s.pickup?.showGstin && vm.gstin ? `<div>GSTIN: ${escapeHtml(vm.gstin)}</div>` : ''}
    </div>
    <div class="right order">
      <div class="b order-line">Order#: ${escapeHtml(vm.orderId || '')}</div>
      ${orderBar}
      ${s.misc?.showInvoiceNumber && vm.invoiceNo ? `<div class="tiny">Invoice No: ${escapeHtml(vm.invoiceNo)}</div>` : ''}
      ${s.misc?.showInvoiceDate && vm.invoiceDate ? `<div class="tiny">Invoice Date: ${escapeHtml(vm.invoiceDate)}</div>` : ''}
      ${s.misc?.showOrderDate && vm.orderDate ? `<div class="tiny">Order Date: ${escapeHtml(vm.orderDate)}</div>` : ''}
    </div>
  </div>
  <div>
    <table class="items"><thead><tr>${heads.join('')}</tr></thead><tbody>${rows}</tbody></table>
    ${vm.hiddenCount > 0 ? `<div class="tiny pad">+${escapeHtml(vm.hiddenCount)} more item(s)</div>` : ''}
    <div class="totals">
      <span>${p.showShippingCharges ? `Shipping Charges: ${escapeHtml(formatInr(vm.shippingCharges))}` : ''}</span>
      <span class="b">
        ${p.showTotalQuantity ? `Total Quantity: ${escapeHtml(vm.totalQty)}` : ''}
        ${p.showCollectableAmount ? `&nbsp;&nbsp;Collectable Amount: ${escapeHtml(formatInr(vm.collectable))}` : ''}
      </span>
    </div>
  </div>
  <div class="foot">
    ${s.misc?.showNotes && s.misc.notes ? `<div class="notes">${escapeHtml(s.misc.notes)}</div>` : ''}
    <div class="foot-row" style="margin-top:6px">
      <span>${s.misc?.showAutoGeneratedDisclaimer ? 'This is an auto generated label and does not require any signature.' : ''}</span>
      <span class="b">${s.misc?.showPoweredBy ? escapeHtml('Powered By ' + (vm.poweredBy || 'OfferWale Baba')) : ''}</span>
    </div>
  </div>
</div>
</body></html>`;
}

module.exports = {
  renderLabelPdf,
  renderLabelHtml,
  PAGE_W,
  PAGE_H
};
