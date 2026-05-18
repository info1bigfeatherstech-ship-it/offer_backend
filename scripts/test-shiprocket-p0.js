/**
 * P0 unit checks — Shiprocket order snapshot + label id resolution (no live API).
 * Run: node scripts/test-shiprocket-p0.js
 */
const assert = require('assert');
const shiprocketInstance = require('../utils/shiprocket');
const ShiprocketService = shiprocketInstance.constructor;

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
  assert.strictEqual(Cls.parseCourierPickupDateValue('2001-02-28'), null);
  assert.strictEqual(Cls.parseCourierPickupDateValue(983318400), null);
  assert.strictEqual(Cls.parseCourierPickupDateValue('For 18 May 2026'), '2026-05-18');
  assert.strictEqual(Cls.parseCourierPickupDateValue('18-May-2026'), '2026-05-18');
  assert.strictEqual(Cls.parseCourierPickupDateValue('18th May 2026'), '2026-05-18');
  assert.strictEqual(Cls.parseCourierPickupDateValue('2026-05-18'), '2026-05-18');
  assert.ok(Cls.isPlausibleCourierPickupYmd('2026-05-18'));
  assert.ok(!Cls.isPlausibleCourierPickupYmd('2001-02-28'));
}

function testOrdersShowShipmentObjectShape() {
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    status: 'PICKUP SCHEDULED',
    pickup_id: 'SRPID-47935881',
    shipments: {
      id: 1346591722,
      awb: '369445882047',
      courier: 'Amazon Prepaid Surface 500g',
      pickup_scheduled_date: '18-May-2026',
      status: 'PICKUP GENERATED'
    }
  });
  assert.strictEqual(snap.shipmentId, '1346591722');
  assert.strictEqual(snap.awbCode, '369445882047');
  assert.strictEqual(snap.pickupDate, '2026-05-18');
  assert.strictEqual(snap.pickupScheduled, true);
}

/** Controllers require('../utils/shiprocket') — the singleton instance, not the class. */
function testInstanceDelegatesUsedByControllers() {
  assert.strictEqual(typeof shiprocketInstance.isPlausibleCourierPickupYmd, 'function');
  assert.strictEqual(typeof shiprocketInstance.parseCourierPickupDateValue, 'function');
  assert.ok(shiprocketInstance.isPlausibleCourierPickupYmd('2026-05-18'));
  assert.ok(!shiprocketInstance.isPlausibleCourierPickupYmd('2001-02-28'));
  assert.strictEqual(shiprocketInstance.isPickupAlreadyScheduledMessage('Already in Pickup Queue.'), true);
}

function testExtractForwardOrderSnapshot() {
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1347554071,
    shipment_id: 987654,
    awb: 'AWB123',
    courier_name: 'Amazon Shipping',
    pickup_scheduled_date: '2026-05-18',
    status: 'PICKUP SCHEDULED',
    status_code: 4,
    label_url: 'https://example.com/label.pdf'
  });
  assert.strictEqual(snap.shiprocketOrderId, '1347554071');
  assert.strictEqual(snap.shipmentId, '987654');
  assert.strictEqual(snap.awbCode, 'AWB123');
  assert.strictEqual(snap.pickupDate, '2026-05-18');
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
  assert.strictEqual(
    ShiprocketService.parsePickupDateFromScheduleResponse(
      { pickup_scheduled_date: '2026-05-18' },
      '2026-05-17'
    ),
    '2026-05-18'
  );
  assert.strictEqual(
    ShiprocketService.parsePickupDateFromScheduleResponse(
      { pickup_date: '2026-05-21', pickup_scheduled_date: '2026-05-18' },
      '2026-05-21'
    ),
    '2026-05-18'
  );
  assert.strictEqual(
    ShiprocketService.parsePickupDateFromScheduleResponse(null, '2026-05-17'),
    '2026-05-17'
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
  const ymd = Cls.extractPickupDateDeepFromRoot({
    pickup_scheduled_date: '2026-05-18',
    pickup_status: 'PICKUP SCHEDULED For 18 May 2026'
  });
  assert.strictEqual(ymd, '2026-05-18');
  assert.strictEqual(Cls.parsePickupDateFromHumanText('For 18 May 2026'), '2026-05-18');
}

function testPickupDateIgnoredWhenOnlyRequestField() {
  const snap = ShiprocketService.extractForwardOrderSnapshot({
    id: 1350319109,
    shipment_id: 987654,
    pickup_date: '2026-05-21',
    pickup_scheduled_date: null,
    status: 'PICKUP SCHEDULED'
  });
  assert.strictEqual(snap.pickupDate, null);
  const strict = ShiprocketService.extractStrictPickupScheduledDateFromOrderShow({
    pickup_date: '2026-05-21',
    pickup_scheduled_date: '2026-05-18'
  });
  assert.strictEqual(strict, '2026-05-18');
}

function testPickupListBatchMatchesShipment() {
  const Cls = shiprocketInstance.constructor;
  const panelPayload = {
    data: [
      {
        pickup_id: 'SRPID-47935881',
        pickup_status: 'PICKUP SCHEDULED For 18 May 2026',
        pickup_scheduled_date: '2026-05-18',
        shipments: [987654, 111222]
      }
    ]
  };
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(panelPayload, 987654), '2026-05-18');
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(panelPayload, 111222), '2026-05-18');
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(panelPayload, 999999), null);

  const nestedWrongChildDate = {
    data: [
      {
        pickup_id: 'SRPID-47935881',
        pickup_scheduled_date: '2026-05-18',
        shipments: [{ shipment_id: 987654, pickup_date: '2026-05-21' }]
      }
    ]
  };
  assert.strictEqual(Cls.findPickupDateInPickupListPayload(nestedWrongChildDate, 987654), '2026-05-18');

  const orderIdsInBatch = {
    data: [
      {
        pickup_id: 'SRPID-47935881',
        pickup_status: 'PICKUP SCHEDULED For 18 May 2026',
        pickup_scheduled_date: '2026-05-18',
        shipments: [1350319109, 1347554071]
      }
    ]
  };
  assert.strictEqual(
    Cls.findPickupDateInPickupListPayload(orderIdsInBatch, { shiprocketOrderId: 1350319109 }),
    '2026-05-18'
  );

  assert.strictEqual(
    Cls.extractStrictPickupScheduledDateFromOrderShow({
      shipments: [{ pickup_status: 'PICKUP SCHEDULED For 18 May 2026' }]
    }),
    '2026-05-18'
  );
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

function run() {
  testNormalizeYmdDate();
  testCourierPickupDateGuards();
  testOrdersShowShipmentObjectShape();
  testInstanceDelegatesUsedByControllers();
  testExtractForwardOrderSnapshot();
  testPickupAlreadyScheduledMessage();
  testParsePickupDateFromScheduleResponse();
  testParseNumericShiprocketOrderId();
  testShippingLabelVsInvoiceUrl();
  testExtractPickupDateDeep();
  testPickupDateIgnoredWhenOnlyRequestField();
  testPickupListBatchMatchesShipment();
  testParsePickupPreferences();
  testBuildPickupCalendarBlocksSunday();
  console.log('All Shiprocket P0 unit checks passed.');
}

run();
