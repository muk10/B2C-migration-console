'use strict';

var attrBuilder = require('*/cartridge/scripts/migration/core/attrBuilder');

var PRODUCT_TYPE_MAP = {
    text:            'string',
    ltext:           'string',
    enum:            'string',
    lenum:           'string',
    number:          'double',
    boolean:         'boolean',
    date:            'date',
    time:            'string',
    datetime:        'datetime',
    money:           'double',
    reference:       'string',
    nested:          'string',
    set:             'set_of_string',
    'set-of-string': 'set_of_string'
};

var CUSTOM_FIELD_TYPE_MAP = {
    String:          'string',
    LocalizedString: 'string',
    Number:          'double',
    Integer:         'int',
    Boolean:         'boolean',
    Date:            'date',
    Time:            'string',
    DateTime:        'datetime',
    Money:           'double',
    Enum:            'string',
    LocalizedEnum:   'string',
    Reference:       'string',
    Set:             'set_of_string'
};

// CT resourceTypeId → SFCC system object type
var RESOURCE_TYPE_MAP = {
    'product':                       'Product',
    'product-variant':               'Product',
    'product-price':                 'Product',
    'category':                      'Category',
    'customer':                      'Customer',
    'customer-group':                'CustomerGroup',
    'order':                         'Order',
    'order-edit':                    'Order',
    'line-item':                     'Order',
    'custom-line-item':              'Order',
    'cart':                          'Order',
    'payment':                       'Order',
    'payment-interface-interaction': 'Order',
    'shopping-list':                 'ProductList',
    'shopping-list-text-line-item':  'ProductListItem',
    'inventory-entry':               'ProductInventoryRecord',
    'store':                         'SitePreferences',
    'discount-code':                 'Promotion',
    'cart-discount':                 'Promotion',
    'channel':                       'SitePreferences',
    'address':                       'Profile',
    'review':                        'Product'
};

// CT types that map to product-related resource IDs
var PRODUCT_RESOURCE_IDS = ['product', 'product-variant', 'product-price'];

var _PERFECT = ['text', 'ltext', 'boolean', 'date', 'datetime', 'number', 'String', 'LocalizedString', 'Boolean', 'Date', 'DateTime', 'Number', 'Integer'];
var _HIGH    = ['enum', 'lenum', 'time', 'Enum', 'LocalizedEnum', 'Time'];
var _MEDIUM  = ['money', 'reference', 'Money', 'Reference'];

/**
 * SFCC custom attribute types (BM UI labels).
 * OCAPI value_type uses snake_case keys below — see attrBuilder.buildAttrDefinition()
 * and SFCC Data API system_object_definitions attribute_definitions.
 */
var SFCC_TYPE_LABELS = {
    string:          'String',
    text:            'Text',
    html:            'HTML',
    int:             'Integer',
    double:          'Number',
    boolean:         'Boolean',
    date:            'Date',
    datetime:        'Date+Time',
    image:           'Image',
    email:           'Email',
    password:        'Password',
    set_of_string:   'Set of Strings',
    set_of_int:      'Set of Integers',
    set_of_double:   'Set of Numbers',
    enum_of_string:  'Enum of Strings',
    enum_of_int:     'Enum of Integers'
};

var CTP_TYPE_FAMILIES = {
    String: 'string', LocalizedString: 'string', text: 'string', ltext: 'string',
    Number: 'number', number: 'number', Money: 'money', money: 'money',
    Integer: 'integer',
    Boolean: 'boolean', boolean: 'boolean',
    Date: 'date', date: 'date',
    DateTime: 'datetime', datetime: 'datetime',
    Time: 'time', time: 'time',
    Enum: 'enum', LocalizedEnum: 'enum', enum: 'enum', lenum: 'enum',
    Reference: 'reference', reference: 'reference',
    Set: 'set', set: 'set', 'set-of-string': 'set'
};

/** Compatible SFCC value_type options per CT type family (subset of BM types). */
var FAMILY_SFCC_OPTIONS = {
    string:    ['string', 'text', 'html', 'email'],
    number:    ['double', 'int'],
    integer:   ['int', 'double'],
    boolean:   ['boolean'],
    date:      ['date'],
    datetime:  ['datetime'],
    time:      ['string', 'text'],
    money:     ['double', 'int'],
    enum:      ['enum_of_string', 'string', 'text', 'enum_of_int'],
    reference: ['string'],
    set:       ['set_of_string', 'set_of_int', 'set_of_double']
};

function ctpTypeFamily(ctpType) {
    return CTP_TYPE_FAMILIES[ctpType] || 'string';
}

/**
 * Allowed SFCC value_type options for a CT type (user-selectable in pre-flight UI).
 * @param {string} ctpType
 * @param {string} [defaultType] - pre-selected value (defaults to resolver output)
 * @returns {Array<{ value: string, label: string }>}
 */
function getSfccTypeOptions(ctpType, defaultType) {
    var family = ctpTypeFamily(ctpType);
    var values = FAMILY_SFCC_OPTIONS[family] || FAMILY_SFCC_OPTIONS.string;
    var def    = defaultType
        || CUSTOM_FIELD_TYPE_MAP[ctpType]
        || PRODUCT_TYPE_MAP[ctpType]
        || 'string';

    if (values.indexOf(def) < 0) {
        values = [def].concat(values);
    }

    var out = [];
    for (var i = 0; i < values.length; i++) {
        var v = values[i];
        out.push({ value: v, label: SFCC_TYPE_LABELS[v] || v });
    }
    return out;
}

/**
 * Build a missing-attribute payload for pre-flight UI (includes selectable SFCC types).
 * @param {Object} entry - { id, label, ctpType, sfccType?, sfccObjectType? }
 * @param {Function} [resolveFn] - optional resolver (resolveCustomFieldType or resolveProductType)
 * @returns {Object}
 */
function enrichMissingAttribute(entry, resolveFn) {
    var resolver = resolveFn || resolveSourceFieldType;
    var sourceType = entry.ctpType || entry.sourceType || '';
    var sfccType = entry.sfccType || resolver(sourceType) || 'string';
    var scope = attrBuilder.resolveAttributeScope(sourceType, entry.sfccObjectType);
    return {
        id:                 entry.id,
        label:              entry.label,
        ctpType:            sourceType,
        sfccType:           sfccType,
        sfccTypeOptions:    getSfccTypeOptions(sourceType, sfccType),
        sourceLocalizable:  scope.sourceLocalizable,
        localizable:        scope.localizable,
        siteSpecific:       scope.siteSpecific,
        scope:              scope.scope
    };
}

function resolveProductType(ctpType) {
    return PRODUCT_TYPE_MAP[ctpType] || 'string';
}

function resolveCustomFieldType(typeName) {
    return CUSTOM_FIELD_TYPE_MAP[typeName] || 'string';
}

// Product-type attribute types are lowercase (set, boolean, number) and are not in the custom-field
// map, so they fell through to 'string': pre-flight then created lists and booleans as String and
// the import kept one value per list. These resolve to their real SFCC type; other product types
// keep 'string' as before (money, for one, is not exported as a number).
var PRODUCT_ATTR_DEFAULTS = { set: 'set_of_string', boolean: 'boolean', number: 'double' };

/**
 * Default SFCC type for a commercetools custom-field type (String, Set, ...) or product-type
 * attribute type (set, boolean, number, ...).
 * @param {string} typeName
 * @returns {string}
 */
function resolveSourceFieldType(typeName) {
    return CUSTOM_FIELD_TYPE_MAP[typeName] || PRODUCT_ATTR_DEFAULTS[typeName] || 'string';
}

function resolveResourceType(resourceTypeId) {
    return RESOURCE_TYPE_MAP[resourceTypeId] || null;
}

function confidence(ctpType) {
    if (_PERFECT.indexOf(ctpType) >= 0) return 100;
    if (_HIGH.indexOf(ctpType) >= 0) return 98;
    if (_MEDIUM.indexOf(ctpType) >= 0) return 95;
    return 90;
}

module.exports = {
    resolveProductType:     resolveProductType,
    resolveCustomFieldType: resolveCustomFieldType,
    resolveResourceType:    resolveResourceType,
    getSfccTypeOptions:     getSfccTypeOptions,
    enrichMissingAttribute: enrichMissingAttribute,
    confidence:             confidence,
    RESOURCE_TYPE_MAP:      RESOURCE_TYPE_MAP,
    PRODUCT_RESOURCE_IDS:   PRODUCT_RESOURCE_IDS
};
