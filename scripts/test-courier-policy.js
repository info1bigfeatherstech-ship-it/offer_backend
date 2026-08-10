/**
 * Unit tests — inactive courier policy.
 * Run: node scripts/test-courier-policy.js
 */
const assert = require('assert');
const {
  resetCourierPolicyCache,
  isCourierInactive,
  filterActiveCouriers,
  pickCheapestActiveCourier,
  buildCourierSubstituteNote
} = require('../services/courierPolicy.service');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  resetCourierPolicyCache();
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
    resetCourierPolicyCache();
  }
}

function testNoDefaultNameBlocksWhenEnvUnset() {
  withEnv({ SHIPROCKET_INACTIVE_COURIER_NAME_PATTERNS: null, SHIPROCKET_INACTIVE_COURIER_IDS: '' }, () => {
    assert.strictEqual(
      isCourierInactive({ courier_name: 'Amazon Shipping Surface 5kg', courier_company_id: 4 }),
      false
    );
    assert.strictEqual(isCourierInactive({ courier_name: 'Delhivery Surface', courier_company_id: 1 }), false);
  });
}

function testNamePatternBlockOnlyWhenEnvSet() {
  withEnv(
    {
      SHIPROCKET_INACTIVE_COURIER_NAME_PATTERNS: 'Amazon Prepaid Surface|Amazon.*Surface',
      SHIPROCKET_INACTIVE_COURIER_IDS: ''
    },
    () => {
      assert.strictEqual(
        isCourierInactive({ courier_name: 'Amazon Prepaid Surface 500g', courier_company_id: 999 }),
        true
      );
      assert.strictEqual(isCourierInactive({ courier_name: 'Delhivery Surface', courier_company_id: 1 }), false);
    }
  );
}

function testInactiveById() {
  withEnv({ SHIPROCKET_INACTIVE_COURIER_IDS: '42,99' }, () => {
    assert.strictEqual(isCourierInactive({ courier_company_id: 42, courier_name: 'Any Courier' }), true);
    assert.strictEqual(isCourierInactive({ courier_company_id: 7, courier_name: 'Fast Express' }), false);
  });
}

function testPickCheapestSkipsInactive() {
  withEnv({ SHIPROCKET_INACTIVE_COURIER_IDS: '1' }, () => {
    const picked = pickCheapestActiveCourier(
      [
        { courier_company_id: 1, courier_name: 'Blocked Cheap', rate: 10 },
        { courier_company_id: 2, courier_name: 'Active Next', rate: 20 }
      ],
      { codRequired: false }
    );
    assert.strictEqual(picked.courierCompanyId, 2);
    assert.strictEqual(picked.courierName, 'Active Next');
  });
}

function testPickCheapestRespectsMaxCharge() {
  withEnv({ SHIPROCKET_INACTIVE_COURIER_IDS: '' }, () => {
    const within = pickCheapestActiveCourier(
      [
        { courier_company_id: 1, courier_name: 'Cheap', rate: 40 },
        { courier_company_id: 2, courier_name: 'Mid', rate: 55 },
        { courier_company_id: 3, courier_name: 'High', rate: 90 }
      ],
      { codRequired: false, maxCharge: 50 }
    );
    assert.strictEqual(within.courierCompanyId, 1);
    const over = pickCheapestActiveCourier(
      [
        { courier_company_id: 2, courier_name: 'Mid', rate: 55 },
        { courier_company_id: 3, courier_name: 'High', rate: 90 }
      ],
      { codRequired: false, maxCharge: 50 }
    );
    assert.strictEqual(over.courierCompanyId, 2);
  });
}

function testSubstituteNote() {
  const note = buildCourierSubstituteNote({
    quotedId: 55,
    quotedName: 'Amazon Prepaid Surface 500g',
    assignedId: 12,
    assignedName: 'Delhivery Air'
  });
  assert.ok(/inactive/i.test(note));
  assert.ok(/Delhivery Air/.test(note));
  assert.ok(/Customer bill unchanged/i.test(note));
}

function run() {
  testNoDefaultNameBlocksWhenEnvUnset();
  testNamePatternBlockOnlyWhenEnvSet();
  testInactiveById();
  testPickCheapestSkipsInactive();
  testPickCheapestRespectsMaxCharge();
  testSubstituteNote();
  console.log('All courier policy tests passed.');
}

run();
