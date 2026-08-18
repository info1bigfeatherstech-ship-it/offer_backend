/**
 * Customer identity is storefront-scoped:
 *   ecomm account  → accountScope 'ecomm'     (userType user)
 *   wholesale      → accountScope 'wholesale' (userType wholesaler)
 *   staff/admin    → accountScope 'staff'     (privileged roles)
 *
 * Same email/phone MAY exist on ecomm + wholesale as two User docs.
 * Staff emails stay reserved (cannot be used as customer contacts).
 */

const ACCOUNT_SCOPES = Object.freeze({
  ECOMM: 'ecomm',
  WHOLESALE: 'wholesale',
  STAFF: 'staff'
});

const PRIVILEGED_OPERATIONAL_ROLES = new Set([
  'admin',
  'product_manager',
  'order_manager',
  'marketing_manager'
]);

function normalizeAccountScope(value) {
  const s = String(value || '').trim().toLowerCase();
  if (s === ACCOUNT_SCOPES.WHOLESALE || s === 'wholesaler' || s === 'b2b') {
    return ACCOUNT_SCOPES.WHOLESALE;
  }
  if (s === ACCOUNT_SCOPES.STAFF || s === 'admin') return ACCOUNT_SCOPES.STAFF;
  return ACCOUNT_SCOPES.ECOMM;
}

function isPrivilegedRole(role) {
  return PRIVILEGED_OPERATIONAL_ROLES.has(String(role || '').trim().toLowerCase());
}

function isPrivilegedAccount(user) {
  if (!user) return false;
  if (String(user.userType || '').trim().toLowerCase() === 'admin') return true;
  if (normalizeAccountScope(user.accountScope) === ACCOUNT_SCOPES.STAFF) return true;
  return isPrivilegedRole(user.role);
}

function isWholesalerAccount(user) {
  if (!user) return false;
  if (normalizeAccountScope(user.accountScope) === ACCOUNT_SCOPES.WHOLESALE) return true;
  const userType = String(user.userType || '').trim().toLowerCase();
  const role = String(user.role || '').trim().toLowerCase();
  return userType === 'wholesaler' || role === 'wholesaler';
}

function deriveAccountScope(user) {
  if (!user) return ACCOUNT_SCOPES.ECOMM;
  if (isPrivilegedAccount(user) && !isWholesalerAccount(user)) {
    return ACCOUNT_SCOPES.STAFF;
  }
  if (isWholesalerAccount(user)) return ACCOUNT_SCOPES.WHOLESALE;
  return ACCOUNT_SCOPES.ECOMM;
}

function customerScopeFromStorefront(storefront) {
  return String(storefront || '').toLowerCase().trim() === 'wholesale'
    ? ACCOUNT_SCOPES.WHOLESALE
    : ACCOUNT_SCOPES.ECOMM;
}

function identifierMatch(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  if (id.includes('@')) return { email: id.toLowerCase() };
  if (/^\d{10}$/.test(id)) return { phone: id };
  return { $or: [{ email: id.toLowerCase() }, { phone: id }] };
}

function contactMatch({ email, phone } = {}) {
  const clauses = [];
  const e = String(email || '').trim().toLowerCase();
  const p = String(phone || '').trim();
  if (e) clauses.push({ email: e });
  if (p) clauses.push({ phone: p });
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function customerScopeFilter(scope) {
  const normalized = normalizeAccountScope(scope);
  if (normalized === ACCOUNT_SCOPES.WHOLESALE) {
    return {
      $or: [
        { accountScope: ACCOUNT_SCOPES.WHOLESALE },
        { userType: 'wholesaler' },
        { role: 'wholesaler' }
      ]
    };
  }
  return {
    $and: [
      {
        $or: [
          { accountScope: ACCOUNT_SCOPES.ECOMM },
          { accountScope: { $exists: false } },
          { accountScope: null }
        ]
      },
      { userType: { $nin: ['wholesaler', 'admin'] } },
      { role: { $nin: [...PRIVILEGED_OPERATIONAL_ROLES, 'wholesaler'] } }
    ]
  };
}

function staffScopeFilter() {
  return {
    $or: [
      { accountScope: ACCOUNT_SCOPES.STAFF },
      { userType: 'admin' },
      { role: { $in: Array.from(PRIVILEGED_OPERATIONAL_ROLES) } }
    ]
  };
}

function andFilters(...filters) {
  const parts = filters.filter(Boolean);
  if (!parts.length) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

function buildCustomerLookup(identifier, scope) {
  const ident = identifierMatch(identifier);
  if (!ident) return null;
  return andFilters(ident, customerScopeFilter(scope));
}

function buildCustomerContactLookup({ email, phone } = {}, scope) {
  const ident = contactMatch({ email, phone });
  if (!ident) return null;
  return andFilters(ident, customerScopeFilter(scope));
}

function buildStaffContactLookup({ email, phone } = {}) {
  const ident = contactMatch({ email, phone });
  if (!ident) return null;
  return andFilters(ident, staffScopeFilter());
}

function pricingUserTypeForStorefront(storefront) {
  return String(storefront || '').toLowerCase().trim() === 'wholesale' ? 'wholesaler' : 'normal';
}

module.exports = {
  ACCOUNT_SCOPES,
  PRIVILEGED_OPERATIONAL_ROLES,
  normalizeAccountScope,
  isPrivilegedRole,
  isPrivilegedAccount,
  isWholesalerAccount,
  deriveAccountScope,
  customerScopeFromStorefront,
  identifierMatch,
  contactMatch,
  customerScopeFilter,
  staffScopeFilter,
  andFilters,
  buildCustomerLookup,
  buildCustomerContactLookup,
  buildStaffContactLookup,
  pricingUserTypeForStorefront
};
