'use strict';

/**
 * SFCC Customer (Profile) system attributes vs customer.xsd.
 * System fields must not be written as <custom-attribute> — import then logs
 * "Object attribute 'phoneMobile' is undefined. Skipping attribute."
 * taxID / taxIDType have no profile XSD child and are not custom attributes —
 * do not emit them as <custom-attribute> (import then skips: undefined).
 */

var PROFILE_XML_TAG = {
    salutation: 'salutation',
    title: 'title',
    firstName: 'first-name',
    secondName: 'second-name',
    lastName: 'last-name',
    suffix: 'suffix',
    companyName: 'company-name',
    jobTitle: 'job-title',
    email: 'email',
    phoneHome: 'phone-home',
    phoneBusiness: 'phone-business',
    phoneMobile: 'phone-mobile',
    fax: 'fax',
    birthday: 'birthday',
    gender: 'gender',
    preferredLocale: 'preferred-locale',
    creationDate: 'creation-date',
    lastLoginTime: 'last-login-time',
    lastVisitTime: 'last-visit-time'
};

var PROFILE_KEY = {
    salutation: 'salutation',
    title: 'title',
    firstName: 'first_name',
    secondName: 'second_name',
    lastName: 'last_name',
    suffix: 'suffix',
    companyName: 'company_name',
    jobTitle: 'job_title',
    email: 'email',
    phoneHome: 'phone_home',
    phoneBusiness: 'phone_business',
    phoneMobile: 'phone_mobile',
    fax: 'fax',
    birthday: 'birthday',
    gender: 'gender',
    preferredLocale: 'preferred_locale',
    creationDate: 'creation_date',
    lastLoginTime: 'last_login_time',
    lastVisitTime: 'last_visit_time',
    taxID: 'tax_id'
};

var SYSTEM_LOWER = {
    uuid: 'UUID',
    birthday: 'birthday',
    companyname: 'companyName',
    creationdate: 'creationDate',
    customerno: 'customerNo',
    email: 'email',
    emailverified: 'emailVerified',
    fax: 'fax',
    firstname: 'firstName',
    gender: 'gender',
    jobtitle: 'jobTitle',
    lastlogintime: 'lastLoginTime',
    lastmodified: 'lastModified',
    lastname: 'lastName',
    lastvisittime: 'lastVisitTime',
    nextbirthday: 'nextBirthday',
    phonebusiness: 'phoneBusiness',
    phonehome: 'phoneHome',
    phonemobile: 'phoneMobile',
    preferredlocale: 'preferredLocale',
    salutation: 'salutation',
    secondname: 'secondName',
    suffix: 'suffix',
    taxid: 'taxID',
    taxidtype: 'taxIDType',
    title: 'title'
};

function systemId(attrId) {
    if (!attrId) return null;
    return SYSTEM_LOWER[String(attrId).toLowerCase()] || null;
}

function profileXmlTag(attrId) {
    var id = systemId(attrId);
    return id && PROFILE_XML_TAG[id] ? PROFILE_XML_TAG[id] : null;
}

function profileKey(attrId) {
    var id = systemId(attrId);
    return id && PROFILE_KEY[id] ? PROFILE_KEY[id] : null;
}

/** System field that must not appear as <custom-attribute>. */
function isNonCustomSystemField(attrId) {
    return !!systemId(attrId);
}

/**
 * SFCC IMPEX datetime rejects a trailing Z. Use yyyy-MM-dd'T'HH:mm:ss.SSS+0000.
 * @param {*} val
 * @returns {string}
 */
function formatImpexDateTime(val) {
    if (val === null || val === undefined || val === '') return '';
    if (typeof val === 'object' && typeof val.toISOString === 'function') {
        val = val.toISOString();
    }
    var s = String(val);
    var zulu = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z$/);
    if (zulu) {
        var ms = zulu[2] || '.000';
        while (ms.length < 4) ms += '0';
        return zulu[1] + ms + '+0000';
    }
    var offset = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)([+-]\d{2}):?(\d{2})$/);
    if (offset) {
        return offset[1] + offset[2] + offset[3];
    }
    return s;
}

function formatCustomAttrValue(val) {
    if (val === true || val === false) return val ? 'true' : 'false';
    if (Array.isArray(val)) {
        return val.map(function (v) { return formatCustomAttrValue(v); }).join(', ');
    }
    return formatImpexDateTime(val);
}

function readCustomerAttrMap() {
    try {
        var attrIdMapSession = require('../core/attrIdMapSession');
        return attrIdMapSession.read('customer') || {};
    } catch (e) {
        return {};
    }
}

function resolveTarget(sourceId, attrMap) {
    try {
        var attrIdMapSession = require('../core/attrIdMapSession');
        return attrIdMapSession.resolve(sourceId, attrMap || {});
    } catch (e) {
        if (!sourceId) return '';
        var mapped = attrMap && attrMap[sourceId];
        return mapped && String(mapped).trim() ? String(mapped).trim() : sourceId;
    }
}

/**
 * Apply visit-scoped Check Attributes maps at XML/write time.
 * Target may be an OOTB Profile field or a custom attribute id.
 *
 * @param {Object} profile - transformer profile (`c_<sourceId>` keys)
 * @param {Object.<string, string>} [attrMap] - source → SFCC id (session if omitted)
 * @returns {{ system: Object, custom: Array<{id: string, value: string}> }}
 */
function applyRuntimeMaps(profile, attrMap) {
    var map = attrMap && typeof attrMap === 'object' ? attrMap : readCustomerAttrMap();
    var system = {};
    var custom = [];
    var seenCustom = {};
    var keys = Object.keys(profile || {});
    var i;
    for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key.length < 3 || key.charAt(0) !== 'c' || key.charAt(1) !== '_') continue;
        var sourceId = key.slice(2);
        var targetId = resolveTarget(sourceId, map);
        var val = profile[key];
        if (val === null || val === undefined || val === '') continue;

        var destKey = profileKey(targetId);
        if (destKey) {
            if (system[destKey] == null || system[destKey] === '') system[destKey] = val;
            continue;
        }
        if (isNonCustomSystemField(targetId)) continue;
        if (seenCustom[targetId]) continue;
        seenCustom[targetId] = true;
        custom.push({ id: targetId, value: val });
    }
    return { system: system, custom: custom };
}

/**
 * Copy mapped OOTB values onto profile keys when those keys are still empty.
 * Lets XML/live writers keep using profile.first_name / phone_mobile / etc.
 * @param {Object} profile
 * @param {{ system: Object }} mapped
 * @returns {Object} profile
 */
function mergeMappedSystem(profile, mapped) {
    profile = profile || {};
    var sys = (mapped && mapped.system) || {};
    var keys = Object.keys(sys);
    var i;
    for (i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (profile[key] == null || profile[key] === '') {
            profile[key] = sys[key];
        }
    }
    if (!profile.phone_mobile && profile.phone) {
        profile.phone_mobile = profile.phone;
    }
    return profile;
}

module.exports = {
    systemId:               systemId,
    profileXmlTag:          profileXmlTag,
    profileKey:             profileKey,
    isNonCustomSystemField: isNonCustomSystemField,
    formatImpexDateTime:    formatImpexDateTime,
    formatCustomAttrValue:  formatCustomAttrValue,
    applyRuntimeMaps:       applyRuntimeMaps,
    mergeMappedSystem:      mergeMappedSystem
};
