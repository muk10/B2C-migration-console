'use strict';

var http        = require('*/cartridge/scripts/migration/core/http');
var cfg         = require('*/cartridge/scripts/migration/configAccessor');
var Encoding    = require('dw/crypto/Encoding');
var Bytes       = require('dw/util/Bytes');
var attrBuilder = require('*/cartridge/scripts/migration/core/attrBuilder');
var runner      = require('*/cartridge/scripts/migration/core/attrPreflightRunner');

var SFCC_OBJECT_TYPE = 'Store';

function toBase64(str) {
    return Encoding.toBase64(new Bytes(str, 'UTF-8'));
}

function getCtpToken() {
    var c    = cfg.ctp;
    var body = 'grant_type=client_credentials';
    var res = http.post(
        c.authUrl + '/oauth/token',
        {
            Authorization:  'Basic ' + toBase64(c.clientId + ':' + c.clientSecret),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    );
    if (res.status !== 200 || !res.data.access_token) {
        throw new Error('CT auth failed (' + res.status + ')');
    }
    return res.data.access_token;
}

function getCtpStoreFields() {
    var c   = cfg.ctp;
    var tok = getCtpToken();
    var qs  = '?where=' + encodeURIComponent('resourceTypeIds contains any ("store")') + '&limit=500';

    var res = http.get(
        c.apiUrl + '/' + c.projectKey + '/types' + qs,
        { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
    );
    if (res.status !== 200) {
        throw new Error('CT Types API failed (' + res.status + ')');
    }

    var fields = [];
    var types  = (res.data && res.data.results) ? res.data.results : [];
    var t;

    for (t = 0; t < types.length; t++) {
        var fieldDefs = types[t].fieldDefinitions || [];
        var f;
        for (f = 0; f < fieldDefs.length; f++) {
            var fd = fieldDefs[f];
            fields.push({
                name:    fd.name,
                label:   attrBuilder.toLabel(fd.label) || fd.name,
                ctpType: fd.type && fd.type.name ? fd.type.name : 'String'
            });
        }
    }
    return fields;
}

function checkMissingAttributes() {
    var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
    var present = {};
    function storeFields() {
        var fields = getCtpStoreFields();
        var i;
        for (i = 0; i < fields.length; i++) {
            if (fields[i] && fields[i].name) present[String(fields[i].name).toLowerCase()] = true;
        }
        return fields;
    }
    var result = runner.checkMissing(
        SFCC_OBJECT_TYPE,
        storeFields,
        null,
        attrIdMapSession.read('store'),
        'store',
        'Store'
    );
    // The curated skip list names every address field a project might use (read into the store
    // address); show only the ones this project's store types have.
    if (result && result.skipped && result.skipped.length) {
        result.skipped = result.skipped.filter(function (s) {
            return s && s.id && present[String(s.id).toLowerCase()];
        });
    }
    return result;
}

function createAttributes(attrs) {
    return runner.createAttributes(SFCC_OBJECT_TYPE, attrs);
}

module.exports = {
    checkMissingAttributes: checkMissingAttributes,
    createAttributes:       createAttributes
};
