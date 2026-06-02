/**
 * P0 unit checks — Shiprocket order snapshot + label id resolution (no live API).
 * Run: node scripts/test-shiprocket-p0.js
 */
const assert = require('assert');
const shiprocketInstance = require('../utils/shiprocket');
const ShiprocketService = shiprocketInstance.constructor;

function nearFuturePickupYmd(daysAhead = 7) {
  return ShiprocketService.addDaysYmd(ShiprocketService.todayYmdUtc(), daysAhead);
}

function nearFuturePickupDmy(daysAhead = 7) {
  const ymd = nearFuturePickupYmd(daysAhead);
  const [y, m, d] = ymd.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

function testNormalizeYmdDate() {
  assert.strictEqual(ShiprocketService.normalizeYmdDate('2026-05-18'), '2026-05-18');
  assert.strictEqual(ShiprocketService.normalizeYmdDate('18-05-2026'), '2026-05-18');
  assert.strictEqual(ShiprocketService.normalizeYmdDate('2026-05-18T10:00:00'), '2026-05-18');
  assert.strictEqual(ShiprocketService.normalizeYmdDate(''), null);
  assert.strictEqual(ShiprocketService.normalizeYmdDate('28 Feb 2001'), null);
  assert.strictEqual(ShiprocketService.normalizeYmdDate('2001-02-28'), '2001-02-28');
}

function testCourierPickupDateGuards() {
  const Cls = ShiprocketService;
  const nearFuture = Cls.addDaysYmd(Cls.todayYmdUtc(), 7);
  assert.strictEqual(Cls.parseCourierPickupDateValue('2001-02-28'), null);
  assert.strictEqual(Cls.parseCourierPickupDateValue(983318400), null);
  assert.strictEqual(Cls.parseCourierPickupDateValue(`For ${nearFuture.split('-')[2]} Jun ${nearFuture.slice(0, 4)}`), nearFuture);
  assert.strictEqual(Cls.parseCourierPickupDateValue(nearFuture), nearFuture);
  assert.ok(Cls.isPlausibleCourierPickupYmd(nearFuture));
  assert.ok(!Cls.isPlausibleCourierPickupYmd('2001-02-28'));
}

function testOrdersShowShipmentObjectShape() {
  const pickupYmd = nearFuturePickupYmd();
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    status: 'PICKUP SCHEDULED',
    pickup_id: 'SRPID-47935881',
    shipments: {
      id: 1346591722,
      awb: '369445882047',
      courier: 'Amazon Prepaid Surface 500g',
      pickup_scheduled_date: pickupYmd,
      status: 'PICKUP GENERATED'
    }
  });
  assert.strictEqual(snap.shipmentId, '1346591722');
  assert.strictEqual(snap.awbCode, '369445882047');
  assert.strictEqual(snap.pickupDate, pickupYmd);
  assert.strictEqual(snap.pickupScheduled, true);
}

/** Controllers require('../utils/shiprocket') — the singleton instance, not the class. */
function testInstanceDelegatesUsedByControllers() {
  const pickupYmd = nearFuturePickupYmd();
  assert.strictEqual(typeof shiprocketInstance.isPlausibleCourierPickupYmd, 'function');
  assert.strictEqual(typeof shiprocketInstance.parseCourierPickupDateValue, 'function');
  assert.ok(shiprocketInstance.isPlausibleCourierPickupYmd(pickupYmd));
  assert.ok(!shiprocketInstance.isPlausibleCourierPickupYmd('2001-02-28'));
  assert.strictEqual(shiprocketInstance.isPickupAlreadyScheduledMessage('Already in Pickup Queue.'), true);
}

function testExtractForwardOrderSnapshot() {
  const pickupYmd = nearFuturePickupYmd();
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1347554071,
    shipment_id: 987654,
    awb: 'AWB123',
    courier_name: 'Amazon Shipping',
    pickup_scheduled_date: pickupYmd,
    status: 'PICKUP SCHEDULED',
    status_code: 4,
    label_url: 'https://example.com/label.pdf'
  });
  assert.strictEqual(snap.shiprocketOrderId, '1347554071');
  assert.strictEqual(snap.shipmentId, '987654');
  assert.strictEqual(snap.awbCode, 'AWB123');
  assert.strictEqual(snap.pickupDate, pickupYmd);
  assert.strictEqual(snap.pickupScheduled, true);
  assert.strictEqual(snap.labelUrl, 'https://example.com/label.pdf');
}

function testPickupAlreadyScheduledMessage() {
  assert.strictEqual(
    ShiprocketService.isPickupAlreadyScheduledMessage('Pickup date scheduled already'),
    true
  );
  assert.strictEqual(
    ShiprocketService.isPickupAlreadyScheduledMessage('Pickup is already scheduled'),
    true
  );
  assert.strictEqual(ShiprocketService.isPickupAlreadyScheduledMessage('Invalid date'), false);
}

function testParsePickupDateFromScheduleResponse() {
  const pickupYmd = nearFuturePickupYmd();
  const fallbackYmd = nearFuturePickupYmd(6);
  const altYmd = nearFuturePickupYmd(10);
  assert.strictEqual(
    ShiprocketService.parsePickupDateFromScheduleResponse(
      { pickup_scheduled_date: pickupYmd },
      fallbackYmd
    ),
    pickupYmd
  );
  assert.strictEqual(
    ShiprocketService.parsePickupDateFromScheduleResponse(
      { pickup_date: altYmd, pickup_scheduled_date: pickupYmd },
      altYmd
    ),
    pickupYmd
  );
  assert.strictEqual(
    ShiprocketService.parsePickupDateFromScheduleResponse(null, nearFuturePickupYmd(5)),
    nearFuturePickupYmd(5)
  );
}

function testParseNumericShiprocketOrderId() {
  assert.strictEqual(shiprocketInstance.parseNumericShiprocketOrderId('1347554071'), 1347554071);
  assert.strictEqual(shiprocketInstance.parseNumericShiprocketOrderId(''), null);
  assert.strictEqual(shiprocketInstance.parseNumericShiprocketOrderId('abc'), null);
}

function testShippingLabelVsInvoiceUrl() {
  const Cls = shiprocketInstance.constructor;
  assert.strictEqual(Cls.isLikelyTaxInvoiceUrl('https://cdn.shiprocket.in/invoice/123.pdf'), true);
  assert.strictEqual(Cls.isLikelyTaxInvoiceUrl('https://cdn.shiprocket.in/labels/awb-123.pdf'), false);
  assert.strictEqual(
    Cls.extractShippingLabelUrl({ label_url: 'https://example.com/label.pdf' }),
    'https://example.com/label.pdf'
  );
  assert.strictEqual(
    Cls.extractShippingLabelUrl({ invoice_url: 'https://example.com/invoice.pdf' }),
    null
  );
  assert.strictEqual(shiprocketInstance.isPickupAlreadyScheduledMessage('Pickup already scheduled'), true);
  assert.strictEqual(shiprocketInstance.isPickupAlreadyScheduledMessage('Already in Pickup Queue.'), true);
}

function testExtractPickupDateDeep() {
  const Cls = shiprocketInstance.constructor;
  const pickupYmd = nearFuturePickupYmd();
  const pickupHuman = nearFuturePickupDmy();
  const ymd = Cls.extractPickupDateDeepFromRoot({
    pickup_scheduled_date: pickupYmd,
    pickup_status: `PICKUP SCHEDULED For ${pickupHuman}`
  });
  assert.strictEqual(ymd, pickupYmd);
  assert.strictEqual(Cls.parsePickupDateFromHumanText(`For ${pickupHuman}`), pickupYmd);
}

function testPickupDateIgnoredWhenOnlyRequestField() {
  const pickupYmd = nearFuturePickupYmd();
  const ignoredYmd = nearFuturePickupYmd(10);
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 987654,
    awb: 'AWB123',
    pickup_date: ignoredYmd,
    pickup_scheduled_date: null,
    status: 'PICKUP SCHEDULED'
  });
  assert.strictEqual(snap.pickupDate, null);
  const strict = ShiprocketService.extractStrictPickupScheduledDateFromOrderShow({
    pickup_date: ignoredYmd,
    pickup_scheduled_date: pickupYmd
  });
  assert.strictEqual(strict, pickupYmd);
}

function testPickupListBatchMatchesShipment() {
  const Cls = shiprocketInstance.constructor;
  const pickupYmd = nearFuturePickupYmd();
  const pickupHuman = nearFuturePickupDmy();
  const panelPayload = {
    data: [
      {
        pickup_id: 'SRPID-47935881',
        pickup_status: `PICKUP SCHEDULED For ${pickupHuman}`,
        pickup_scheduled_date: pickupYmd,
        shipments: [987654, 111222]
      }
    ]
  };
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(panelPayload, 987654), pickupYmd);
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(panelPayload, 111222), pickupYmd);
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(panelPayload, 999999), null);

  const match = Cls.findPickupBatchMatchInPickupListPayload(panelPayload, 987654);
  assert.strictEqual(match?.pickupDate, pickupYmd);
  assert.strictEqual(match?.pickupId, 'SRPID-47935881');
  assert.strictEqual(Cls.normalizeShiprocketPickupId('48421432'), 'SRPID-48421432');
  assert.strictEqual(Cls.normalizeShiprocketPickupId('SRPID-48421432'), 'SRPID-48421432');

  const nestedWrongChildDate = {
    data: [
      {
        pickup_id: 'SRPID-47935881',
        pickup_scheduled_date: pickupYmd,
        shipments: [{ shipment_id: 987654, pickup_date: nearFuturePickupYmd(10) }]
      }
    ]
  };
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(nestedWrongChildDate, 987654), pickupYmd);

  const orderIdsInBatch = {
    data: [
      {
        pickup_id: 'SRPID-47935881',
        pickup_status: `PICKUP SCHEDULED For ${pickupHuman}`,
        pickup_scheduled_date: pickupYmd,
        shipments: [1350319109, 1347554071]
      }
    ]
  };
  assert.strictEqual(
    Cls.findPickupDateInPickupListPayload(orderIdsInBatch, { shiprocketOrderId: 1350319109 }),
    pickupYmd
  );

  assert.strictEqual(
    Cls.extractStrictPickupScheduledDateFromOrderShow({
      shipments: [{ pickup_status: `PICKUP SCHEDULED For ${pickupHuman}` }]
    }),
    pickupYmd
  );
}

function testCompletedPickupBatchWithOldDateStillReturnsPickupId() {
  const Cls = shiprocketInstance.constructor;
  const panelPayload = {
    data: [
      {
        pickup_id: 'SRPID-48332890',
        pickup_status: 'PICKUP COMPLETED',
        pickup_scheduled_date: '2026-05-29',
        shipments: [987654]
      }
    ]
  };
  const match = Cls.findPickupBatchMatchInPickupListPayload(panelPayload, 987654);
  assert.strictEqual(match?.pickupId, 'SRPID-48332890');

  const snap = Cls.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 987654,
    awb: '14112362507328',
    status: 'OUT FOR DELIVERY',
    pickup_id: 'SRPID-48332890'
  });
  assert.strictEqual(snap.shiprocketPickupId, 'SRPID-48332890');
}

function testParsePickupPreferences() {
  const pickupCalendarUtil = require('../utils/shiprocketPickupCalendar');
  const prefs = pickupCalendarUtil.parsePickupPreferencesFromPayload(
    {
      data: [
        {
          pickup_location: 'work',
          sunday: 0,
          monday: 1,
          tuesday: 1,
          wednesday: 1,
          thursday: 1,
          friday: 1,
          saturday: 1
        }
      ]
    },
    { pickupLocationNickname: 'work' }
  );
  assert.ok(prefs.blockedWeekdays.includes(0));
  assert.strictEqual(prefs.hasScheduleRules, true);

  const merged = pickupCalendarUtil.parsePickupPreferencesFromPayload(
    {
      sunday: 0,
      data: [{ pickup_location: 'work', address: 'Test' }]
    },
    { pickupLocationNickname: 'work' }
  );
  assert.ok(merged.blockedWeekdays.includes(0), 'weekday rules on root should merge with location record');
}

function testBuildPickupCalendarBlocksSunday() {
  const pickupCalendarUtil = require('../utils/shiprocketPickupCalendar');
  const cal = pickupCalendarUtil.buildPickupCalendar(
    { blockedWeekdays: [0], holidays: [] },
    { daysAhead: 14 }
  );
  const sundays = cal.dates.filter((d) => {
    const dow = pickupCalendarUtil.weekdayIndexInTimeZone(
      new Date(`${d.date}T12:00:00Z`)
    );
    return dow === 0;
  });
  assert.ok(sundays.length > 0);
  assert.ok(sundays.every((d) => d.allowed === false));
}

function testExtractForwardOrderAutoCancelSnapshot() {
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    status: 'NEW',
    status_message: 'Shipment auto-cancelled due to no pickup done in 10 days from pickup generated date',
    shipments: {
      id: 1346591722,
      awb: '',
      status: 'NEW'
    }
  });
  assert.strictEqual(snap.resetDetected, true);
  assert.ok(/auto[- ]?cancel/i.test(String(snap.resetReason || snap.statusMessage || '')));
}

function testAwbAssignedIgnoresStalePickupFieldsAfterReship() {
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 1346591722,
    status: 'AWB Assigned',
    awb: '14112362507328',
    courier_name: 'Xpressbees Surface',
    pickup_scheduled_date: '18-May-2026',
    pickup_status: 'For 18 May 2026',
    label_url: 'https://example.com/label.pdf'
  });
  assert.strictEqual(snap.pickupScheduled, false);
  assert.strictEqual(snap.pickupDate, null);
  assert.strictEqual(snap.providerStatus, 'AWB Assigned');
  assert.strictEqual(snap.providerSnapshot.pickupScheduled, false);
}

function testMirrorProviderStatusWhenPickupScheduled() {
  const status = ShiprocketService.resolveMirrorProviderStatusFromOrderShow(
    {
      status: 'Pickup Generated',
      pickup_status: 'PICKUP SCHEDULED For 30 May 2026',
      pickup_scheduled_date: '30-May-2026'
    },
    { pickupScheduled: true, pickupDate: '2026-05-30', statusLabel: 'Pickup Generated' }
  );
  assert.strictEqual(status, 'PICKUP SCHEDULED');
}

function testForwardProgressIgnoresStalePickupCancelledInResetDetection() {
  const { detectForwardOrderReset, sanitizeTrackingEventsForProvider } = require('../services/shipmentOps/shiprocketStatusMap');
  const reset = detectForwardOrderReset({
    statusLabel: 'Pickup Generated',
    statusCode: 4,
    awbCode: '14112362507328',
    hadLocalAwb: true,
    texts: ['PickupCancelled', 'PickupCancelled']
  });
  assert.strictEqual(reset.resetDetected, false);

  const resetOfp = detectForwardOrderReset({
    statusLabel: 'Out For Pickup',
    awbCode: '14112362507328',
    hadLocalAwb: true,
    texts: ['PickupCancelled', 'Out For Pickup']
  });
  assert.strictEqual(resetOfp.resetDetected, false);

  const events = sanitizeTrackingEventsForProvider(
    [{ status: 'PickupCancelled', description: 'PickupCancelled', at: '2026-05-25' }],
    'Pickup Generated'
  );
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].status, 'Pickup Generated');

  const eventsOfp = sanitizeTrackingEventsForProvider(
    [
      { status: 'PickupCancelled', description: 'PickupCancelled', at: '2026-05-25' },
      { status: 'OFP', description: 'Out For Pickup', at: '2026-05-30' }
    ],
    'Out For Pickup'
  );
  assert.strictEqual(eventsOfp.some((e) => /pickupcancelled/i.test(String(e.status || ''))), false);
}

function testPickupScheduledWithoutAwbIsStaleCycle() {
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 1346591722,
    status: 'PICKUP SCHEDULED',
    pickup_scheduled_date: '18-May-2026',
    pickup_status: 'PICKUP SCHEDULED For 18 May 2026',
    shipments: { id: 1346591722, awb: '', status: 'PICKUP SCHEDULED' }
  });
  assert.strictEqual(snap.awbCode, null);
  assert.strictEqual(snap.pickupScheduled, false);
  assert.strictEqual(snap.pickupDate, null);
  assert.strictEqual(snap.resetDetected, true);

  const { detectForwardOrderReset } = require('../services/shipmentOps/shiprocketStatusMap');
  const reset = detectForwardOrderReset({
    statusLabel: 'PICKUP SCHEDULED',
    statusCode: 4,
    awbCode: null,
    hadLocalAwb: true,
    hadLocalPickup: true,
    texts: ['pickup scheduled for 18 may 2026']
  });
  assert.strictEqual(reset.resetDetected, true);
}

function run() {
  testNormalizeYmdDate();
  testCourierPickupDateGuards();
  testOrdersShowShipmentObjectShape();
  testInstanceDelegatesUsedByControllers();
  testExtractForwardOrderSnapshot();
  testExtractForwardOrderAutoCancelSnapshot();
  testAwbAssignedIgnoresStalePickupFieldsAfterReship();
  testForwardProgressIgnoresStalePickupCancelledInResetDetection();
  testPickupScheduledWithoutAwbIsStaleCycle();
  testMirrorProviderStatusWhenPickupScheduled();
  testPickupAlreadyScheduledMessage();
  testParsePickupDateFromScheduleResponse();
  testParseNumericShiprocketOrderId();
  testShippingLabelVsInvoiceUrl();
  testExtractPickupDateDeep();
  testPickupDateIgnoredWhenOnlyRequestField();
  testPickupListBatchMatchesShipment();
  testCompletedPickupBatchWithOldDateStillReturnsPickupId();
  testParsePickupPreferences();
  testBuildPickupCalendarBlocksSunday();
  console.log('All Shiprocket P0 unit checks passed.');
}

run();
