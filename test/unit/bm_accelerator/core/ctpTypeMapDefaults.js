'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var loader = require('../helpers/cartridgeLoader');

describe('ctpTypeMap default SFCC types', function () {
    var typeMap;

    before(function () {
        typeMap = loader.requireCartridge('connectors/ctp/ctpTypeMap');
    });

    it('creates product-type lists, booleans and numbers with their own SFCC type, not String', function () {
        assert.equal(typeMap.enrichMissingAttribute({ id: 'stores', ctpType: 'set' }).sfccType, 'set_of_string');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'isB2B', ctpType: 'boolean' }).sfccType, 'boolean');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'servings', ctpType: 'number' }).sfccType, 'double');
        assert.notInclude(typeMap.enrichMissingAttribute({ id: 'stores', ctpType: 'set' }).sfccTypeOptions.map(function (o) { return o.value; }), 'string');
    });

    it('keeps custom-field types and the other product types as before', function () {
        assert.equal(typeMap.enrichMissingAttribute({ id: 'tags', ctpType: 'Set' }).sfccType, 'set_of_string');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'flag', ctpType: 'Boolean' }).sfccType, 'boolean');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'gtin', ctpType: 'text' }).sfccType, 'string');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'faq', ctpType: 'enum' }).sfccType, 'string');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'price', ctpType: 'money' }).sfccType, 'string');
        assert.equal(typeMap.enrichMissingAttribute({ id: 'custom', ctpType: 'ltext', sfccType: 'html' }).sfccType, 'html');
    });
});
