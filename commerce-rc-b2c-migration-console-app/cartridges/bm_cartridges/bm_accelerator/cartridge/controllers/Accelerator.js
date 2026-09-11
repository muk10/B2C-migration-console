'use strict';

/* global request, response, session, Packages */

/* eslint-disable no-var */

var ISML           = require('dw/template/ISML');
var URLUtils       = require('dw/web/URLUtils');
var Resource       = require('dw/web/Resource');
var migrationData  = require('*/cartridge/scripts/accelerator/migrationData');
var dataMigrationSession = require('*/cartridge/scripts/accelerator/dataMigrationSession');
var registry       = require('*/cartridge/scripts/migration/connectors/registry');

// ─── Controller helpers ───────────────────────────────────────────────────────

/**
 * @param {number} n - step number
 * @returns {string|null} step as string, or null if absent
 */
function toStepQuery(n) {
    if (n === null || n === undefined) return null;
    return String(parseInt(String(n), 10));
}

/**
 * Attach Business Manager navigation frame context for MenuFrame.isml.
 * @param {Object} pdict
 * @param {string} [menuActionId]
 * @returns {Object}
 */
function withBmFrame(pdict, menuActionId) {
    var requestGuard = require('*/cartridge/scripts/accelerator/requestGuard');
    pdict.SelectedMenuItem = 'rc_accelerator_tools';
    pdict.CurrentMenuItemId = menuActionId || 'rc_accelerator_wizard';
    return requestGuard.attachCsrf(pdict);
}

/**
 * @param {Object} obj - response payload
 * @returns {void}
 */
function jsonResponse(obj) {
    response.setContentType('application/json');
    response.writer.print(JSON.stringify(obj));
}

/**
 * Persist attr renames and return standard create-attrs JSON.
 * @param {string} moduleKey
 * @param {Function} createFn - (attrs) => result
 * @param {Array} attrs
 */
function respondCreateAttributes(moduleKey, createFn, attrs) {
    var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
    var result = createFn(attrs);
    if (result && result.mappedAttrs && result.mappedAttrs.length) {
        attrIdMapSession.saveFromAttrs(moduleKey, result.mappedAttrs);
    }
    jsonResponse({
        ok:     !(result && result.failed > 0),
        result: result
    });
}

/**
 * Normalize check-attrs result. AI suggestions load async when aiStatus is "pending".
 * @param {{ mapped?: Array, missing?: Array, suggested?: Array, coveragePending?: Array, skipped?: Array, aiStatus?: string, aiMessage?: string, taskName?: string, sfccObjectType?: string }|Array} result
 */
function respondCheckAttributes(result) {
    var suggestUrl = URLUtils.url('Accelerator-SuggestAttrMaps').toString();
    if (Array.isArray(result)) {
        jsonResponse({
            ok: true,
            mapped: [],
            missing: result,
            suggested: [],
            coveragePending: [],
            skipped: [],
            aiStatus: 'skipped',
            aiMessage: '',
            taskName: '',
            sfccObjectType: '',
            suggestAttrMapsUrl: suggestUrl,
            sessionSystemMaps: [],
            noDynamicFieldSource: false
        });
        return;
    }
    jsonResponse({
        ok:                 true,
        mapped:             (result && result.mapped) || [],
        missing:            (result && result.missing) || [],
        suggested:          (result && result.suggested) || [],
        coveragePending:    (result && result.coveragePending) || [],
        skipped:            (result && result.skipped) || [],
        aiStatus:           (result && result.aiStatus) || 'skipped',
        aiMessage:          (result && result.aiMessage) || '',
        taskName:           (result && result.taskName) || '',
        sfccObjectType:     (result && result.sfccObjectType) || '',
        suggestAttrMapsUrl: suggestUrl,
        sessionSystemMaps:  (result && result.sessionSystemMaps) || [],
        noDynamicFieldSource: !!(result && result.noDynamicFieldSource)
    });
}

/**
 * @param {string} moduleKey
 */
function clearModuleAttrIdMap(moduleKey) {
    require('*/cartridge/scripts/migration/core/attrIdMapSession').clear(moduleKey);
}

/**
 * @param {string} moduleKey
 * @returns {string}
 */
function clearAttrMapUrlFor(moduleKey) {
    return URLUtils.url('Accelerator-ClearAttrIdMap', 'module', moduleKey).toString();
}

/**
 * Parse attrs JSON from request; writes error JSON and returns null on failure.
 * @returns {Array|null}
 */
function parseAttrsParam() {
    var rawAttrs = getParam('attrs');
    var attrs    = [];
    try { attrs = JSON.parse(rawAttrs || '[]'); } catch (e) {
        jsonResponse({ ok: false, error: 'Invalid attrs JSON' });
        return null;
    }
    if (!attrs.length) {
        jsonResponse({ ok: false, error: 'No attributes provided' });
        return null;
    }
    return attrs;
}

/**
 * JSON-encoded value safe to embed in inline <script> (includes quotes).
 * @param {*} val
 * @returns {string}
 */
function toJsLiteral(val) {
    return JSON.stringify(val == null ? '' : String(val));
}

/**
 * @param {string} name - parameter name
 * @returns {string} parameter value or empty string
 */
function getParam(name) {
    var p = request.httpParameterMap[name];
    return (p && p.submitted) ? String(p.stringValue || '') : '';
}

/**
 * Resolve the active platform from the request param, falling back to session.
 * @returns {string} platform ID
 */
function resolvePlatform() {
    var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
    return getParam('platform') || registry.getPlatformId();
}

/**
 * Resolve the data-source fetcher for the active migration platform.
 * @param {string} moduleKey
 * @returns {Object}
 */
function getMigrationFetcher(moduleKey) {
    var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
    return registry.getFetcher(moduleKey);
}

/**
 * @param {string} [platformId]
 * @returns {boolean} whether data migration connection was verified for this platform
 */
function isDataMigrationConnected(platformId) {
    var pid = platformId || resolvePlatform();
    return dataMigrationSession.isConnected(pid);
}

/**
 * Platform tiles on the dashboard — attach data-wizard connection + logout URL.
 * @returns {Array}
 */
function platformsForDashboard() {
    var platforms = migrationData.getPlatforms();
    var result    = [];
    var i;
    var p;
    var enriched;
    var keys;
    var k;

    for (i = 0; i < platforms.length; i++) {
        p = platforms[i];
        enriched = {};
        keys = Object.keys(p);
        for (k = 0; k < keys.length; k++) {
            enriched[keys[k]] = p[keys[k]];
        }
        enriched.dataConnected = dataMigrationSession.isConnected(p.id);
        enriched.logoutUrl     = URLUtils.url('Accelerator-DataMigrationLogout', 'platform', p.id).toString();
        result.push(enriched);
    }
    return result;
}

/**
 * Shared IMPEX + wizard entry URLs for dedicated migration pages.
 * @param {string} platformId
 * @param {string} moduleKey - key in migrationPaths.MODULE_IDS
 * @returns {Object}
 */
function migrationPageContext(platformId, moduleKey) {
    var migPaths  = require('*/cartridge/scripts/migration/core/migrationPaths');
    var bmLinks   = require('*/cartridge/scripts/accelerator/bmLinks');
    var registry  = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
    var impexPath = migPaths.getRelativePath(moduleKey);
    return {
        platformId:         platformId,
        sourceLabel:        registry.getSourceLabel(platformId),
        migrationUi:        migrationData.getMigrationUi(platformId),
        migrationUiJson:    migrationData.getMigrationUiJson(platformId),
        impexPath:          impexPath,
        impexUrl:           bmLinks.getImpexFolderUrl(impexPath),
        dataWizardEntryUrl: dataMigrationSession.dataWizardUrl(platformId),
        dataWizardSelectUrl: dataMigrationSession.dataWizardSelectUrl(platformId)
    };
}

/**
 * Build connector credentials from Site Preferences, with optional request overlay for Amplience CMS forms.
 * @param {string} platformId - source platform identifier
 * @returns {Object} credentials object for the connector
 */
function buildConnectionCreds(platformId) {
    var cfg = require('*/cartridge/scripts/migration/configAccessor');
    var creds = {};

    if (platformId === 'commercetools') {
        creds.projectKey   = cfg.ctp.projectKey || '';
        creds.clientId     = cfg.ctp.clientId || '';
        creds.clientSecret = cfg.ctp.clientSecret || '';
        creds.authUrl      = cfg.ctp.authUrl || 'https://auth.us-central1.gcp.commercetools.com';
        creds.apiUrl       = cfg.ctp.apiUrl || 'https://api.us-central1.gcp.commercetools.com';
    } else if (platformId === 'shopify') {
        creds.storeUrl     = cfg.shopify.storeUrl || '';
        creds.clientId     = cfg.shopify.clientId || '';
        creds.clientSecret = cfg.shopify.clientSecret || '';
        creds.accessToken  = cfg.shopify.accessToken || '';
        creds.apiVersion   = cfg.shopify.apiVersion || '2025-01';
    } else if (platformId === 'bigcommerce') {
        creds.storeHash   = (cfg.bigcommerce && cfg.bigcommerce.storeHash) || '';
        creds.clientId    = (cfg.bigcommerce && cfg.bigcommerce.clientId) || '';
        creds.accessToken = (cfg.bigcommerce && cfg.bigcommerce.accessToken) || '';
        creds.apiVersion  = (cfg.bigcommerce && cfg.bigcommerce.apiVersion) || 'v3';
    } else if (platformId === 'amplience') {
        creds.hubName             = (cfg.amplience && cfg.amplience.hubName) || '';
        creds.personalAccessToken = (cfg.amplience && cfg.amplience.personalAccessToken) || '';
        creds.defaultDeliveryKey  = (cfg.amplience && cfg.amplience.defaultDeliveryKey) || '';
    } else if (platformId === 'sap') {
        creds.baseUrl      = cfg.sap.baseUrl || '';
        creds.baseSite     = cfg.sap.baseSite || '';
        creds.clientId     = cfg.sap.clientId || '';
        creds.clientSecret = cfg.sap.clientSecret || '';
    }

    return creds;
}

/**
 * @param {string} platformId
 * @param {Object} creds
 * @returns {boolean}
 */
function hasConnectionCreds(platformId, creds) {
    return buildConnectionSummary(platformId).configured;
}

/**
 * Non-secret summary of configured prefs for the Connect step UI.
 * @param {string} platformId
 * @returns {{ configured: boolean, lines: Array<{label: string, value: string}>, prefsHint: string }}
 */
function buildConnectionSummary(platformId) {
    var cfg = require('*/cartridge/scripts/migration/configAccessor');
    var lines = [];
    var configured = false;

    if (platformId === 'commercetools') {
        configured = !!(cfg.ctp.projectKey && cfg.ctp.clientId && cfg.ctp.clientSecret);
        lines.push({ label: 'Project key', value: cfg.ctp.projectKey || '(not set)' });
        lines.push({ label: 'Client ID', value: cfg.ctp.clientId || '(not set)' });
        lines.push({ label: 'Client secret', value: cfg.ctp.clientSecret ? 'Configured' : '(not set)' });
        lines.push({ label: 'API URL', value: cfg.ctp.apiUrl || '(not set)' });
    } else if (platformId === 'shopify') {
        var hasSecret = !!(cfg.shopify.clientSecret || cfg.shopify.accessToken);
        configured = !!(cfg.shopify.storeUrl && hasSecret);
        lines.push({ label: 'Store URL', value: cfg.shopify.storeUrl || '(not set)' });
        lines.push({ label: 'Client ID', value: cfg.shopify.clientId || '(not set)' });
        lines.push({ label: 'Secret / token', value: hasSecret ? 'Configured' : '(not set)' });
        lines.push({ label: 'API version', value: cfg.shopify.apiVersion || '(not set)' });
    } else if (platformId === 'bigcommerce') {
        var bc = cfg.bigcommerce || {};
        configured = !!(bc.storeHash && bc.accessToken);
        lines.push({ label: 'Store hash', value: bc.storeHash || '(not set)' });
        lines.push({ label: 'Client ID', value: bc.clientId || '(not set)' });
        lines.push({ label: 'Access token', value: bc.accessToken ? 'Configured' : '(not set)' });
        lines.push({ label: 'API version', value: bc.apiVersion || 'v3' });
    } else if (platformId === 'sap') {
        configured = !!(cfg.sap.baseUrl && cfg.sap.baseSite && cfg.sap.clientId && cfg.sap.clientSecret);
        lines.push({ label: 'Base URL', value: cfg.sap.baseUrl || '(not set)' });
        lines.push({ label: 'Base Site', value: cfg.sap.baseSite || '(not set)' });
        lines.push({ label: 'Client ID', value: cfg.sap.clientId || '(not set)' });
        lines.push({ label: 'Client secret', value: cfg.sap.clientSecret ? 'Configured' : '(not set)' });
    } else if (platformId === 'amplience') {
        var amp = cfg.amplience || {};
        var hub = amp.hubName || '';
        var pat = amp.personalAccessToken || '';
        var key = amp.defaultDeliveryKey || '';
        configured = !!(hub && pat);
        lines.push({ label: 'Hub name', value: hub, placeholder: 'my-brand' });
        lines.push({
            label:       'Personal access token',
            value:       pat ? '••••••••' : '',
            placeholder: 'amp_pat_...',
            secret:      true
        });
        lines.push({
            label:       'Default delivery key',
            value:       key,
            placeholder: 'home/banner',
            optional:    true
        });
    }

    return {
        configured: configured,
        lines:      lines,
        prefsHint:  'Site Preferences → Custom Preferences → B2C Migration Console'
    };
}


// ─── AJAX endpoints ───────────────────────────────────────────────────────────

/**
 * Test connection using Site Preference credentials.
 */
exports.TestConnection = function () {
    response.setContentType('application/json');

    var platformId = getParam('platformId') || 'commercetools';
    var connector  = registry.get(platformId);

    if (!connector) {
        jsonResponse({ ok: false, error: 'Unsupported platform: ' + platformId });
        return;
    }

    var creds = buildConnectionCreds(platformId);
    var summary = buildConnectionSummary(platformId);
    if (!hasConnectionCreds(platformId, creds)) {
        jsonResponse({
            ok: false,
            error: 'Credentials are not configured. Set them under ' + summary.prefsHint + '.'
        });
        return;
    }

    try {
        var result = connector.testConnectionWith(creds);
        if (getParam('mode') === 'data' || platformId === 'amplience') {
            dataMigrationSession.markConnected(platformId, result.expiresIn);
        }
        jsonResponse({ ok: true, project: result.project });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.TestConnection.public = true;

// ─── Page endpoints ───────────────────────────────────────────────────────────

exports.Start = function () {
    ISML.renderTemplate('accelerator/dashboard', withBmFrame({
        title:                     Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:                  Resource.msg('accelerator.subtitle', 'accelerator', null),
        platforms:                 platformsForDashboard(),
        dataWizardUrl:             URLUtils.url('Accelerator-DataWizard').toString(),
        dataMigrationDashboardUrl: URLUtils.url('Accelerator-DataMigrationDashboard').toString(),
        customerMigrationUrl:      URLUtils.url('Accelerator-CustomerMigration').toString(),
        shippingMethodMigrationUrl: URLUtils.url('Accelerator-ShippingMethodMigration').toString(),
        inventoryMigrationUrl:     URLUtils.url('Accelerator-InventoryMigration').toString(),
        pricebookMigrationUrl:     URLUtils.url('Accelerator-PricebookMigration').toString(),
        taxMigrationUrl:           URLUtils.url('Accelerator-TaxMigration').toString(),
        storeMigrationUrl:         URLUtils.url('Accelerator-StoreMigration').toString(),
        orderMigrationUrl:         URLUtils.url('Accelerator-OrderMigration').toString(),
        productWizardUrl:          URLUtils.url('Accelerator-ProductWizard').toString(),
        categoryMigrationUrl:      URLUtils.url('Accelerator-CategoryMigration').toString(),
        contentMigrationUrl:       URLUtils.url('Accelerator-ContentMigration').toString(),
        cssUrl:                    URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        jsUrl: URLUtils.staticURL('/js/categoryMigration.js').toString(),
        fetchCatalogsUrl : URLUtils.url('Accelerator-FetchSFCCCatalogs').toString(),
        createCatalogUrl : URLUtils.url('Accelerator-CreateCatalog').toString(),
        createCategoryUrl:  URLUtils.url('Accelerator-CreateCategory').toString()
    }));
};
exports.Start.public = true;

/**
 * Clear data-migration connection for a platform (logout from source).
 * GET platform=commercetools|shopify
 */
exports.DataMigrationLogout = function () {
    var platformId = getParam('platform') || getParam('platformId') || '';

    if (platformId && dataMigrationSession.isConnected(platformId)) {
        dataMigrationSession.clearConnection();
    }

    response.redirect(URLUtils.url('Accelerator-Start'));
};
exports.DataMigrationLogout.public = true;

/**
 * Legacy entry — redirect into the data wizard (connect → select data).
 */
exports.DataMigrationDashboard = function () {
    var platformId = resolvePlatform();
    response.redirect(URLUtils.url(
        'Accelerator-DataWizard',
        'platform', platformId,
        'step', dataMigrationSession.connectOrSelectStep(platformId)
    ));
};
exports.DataMigrationDashboard.public = true;

/**
 * Order migration page — single-page flow like inventory and pricebook.
 */
exports.OrderMigration = function () {
    var platformId = resolvePlatform();

    if (!isDataMigrationConnected(platformId)) {
        response.redirect(URLUtils.url(
            'Accelerator-DataWizard',
            'platform', platformId,
            'step', dataMigrationSession.connectOrSelectStep(platformId)
        ));
        return;
    }

    session.custom.selectedDataType = 'order';
    var pageCtx        = migrationPageContext(platformId, 'order');
    var bmLinks        = require('*/cartridge/scripts/accelerator/bmLinks');
    var jobsUrl        = bmLinks.getImportExportUrl();

    clearModuleAttrIdMap('order');

    ISML.renderTemplate('accelerator/orderMigration', withBmFrame({
        title:               Resource.msg('accelerator.ordermigration.heading', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        impexPath:           pageCtx.impexPath,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        countUrl:            URLUtils.url('Accelerator-CountOrders').toString(),
        exportUrl:           URLUtils.url('Accelerator-ExportOrders').toString(),
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckOrderAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreateOrderAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('order'),
        impexUrl:            pageCtx.impexUrl,
        jobsUrl:             jobsUrl,
        orderStateFilters:   migrationData.getOrderStateFilters(platformId),
        paymentStateFilters: migrationData.getPaymentStateFilters(platformId),
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        orderMigrationJsUrl: URLUtils.staticURL('/js/order-migration.js').toString() + '?v=6'
    }));
};
exports.OrderMigration.public = true;

/**
 * Export orders from commercetools and generate IMPEX package.
 * POST: years=1|2|3&maxCount=optional&orderState=optional&paymentState=optional
 */
exports.ExportOrders = function () {
    var platformId   = resolvePlatform();
    var offset       = parseInt(getParam('offset') || '0', 10);
    var singleFile   = getParam('singleFile') !== 'false';
    var years        = parseInt(getParam('years') || String(session.custom.orderExportYears || '1'), 10);
    var maxRaw       = getParam('maxCount') || String(session.custom.orderExportMaxCount || '');
    var maxCount     = maxRaw ? parseInt(maxRaw, 10) : null;
    var orderState   = getParam('orderState') || String(session.custom.orderExportOrderState || '');
    var paymentState = getParam('paymentState') || String(session.custom.orderExportPaymentState || '');

    if ([1, 2, 3].indexOf(years) < 0) {
        jsonResponse({ ok: false, error: 'Years must be 1, 2, or 3' });
        return;
    }

    if (!migrationData.isValidOrderState(platformId, orderState)
        || !migrationData.isValidPaymentState(platformId, paymentState)) {
        jsonResponse({ ok: false, error: 'Invalid order or payment state filter' });
        return;
    }

    try {
        var fullRunner = require('*/cartridge/scripts/migration/orders/fullMigrationRunner');
        var result     = fullRunner.runBatch(offset, {
            years:        years,
            maxCount:     maxCount,
            orderState:   orderState,
            paymentState: paymentState
        }, singleFile);

        if (!result.ok) {
            jsonResponse({ ok: false, error: result.error });
            return;
        }

        if (result.done && offset === 0) {
            session.custom.orderMigrationReport = JSON.stringify({
                ordersProcessed:   result.ordersProcessed,
                ordersValidated:   result.ordersValidated,
                ordersFailed:      result.ordersFailed,
                xmlFilesGenerated: result.xmlFilesGenerated,
                runId:             result.runId,
                impexPath:         result.impexPath || 'src/migration/order',
                fileName:          result.fileName || ''
            });
        }

        var downloadFiles = [];
        if (result.fileName && result.impexPath) {
            downloadFiles.push({
                name:         result.fileName,
                relativePath: result.impexPath + '/' + result.fileName,
                isZip:        false
            });
        }

        jsonResponse({
            ok:         true,
            singleFile: result.singleFile,
            done:       result.done,
            total:      result.total,
            nextOffset: result.nextOffset,
            built:      result.built,
            failed:     result.failed,
            errors:     result.errors || [],
            report: {
                ordersProcessed:   result.ordersProcessed,
                ordersValidated:   result.ordersValidated,
                ordersFailed:      result.ordersFailed,
                xmlFilesGenerated: result.xmlFilesGenerated
            },
            runId:         result.runId,
            fileName:      result.fileName,
            impexPath:     result.impexPath,
            downloadFiles: downloadFiles
        });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ExportOrders.public = true;

/**
 * Count orders matching export filters (commercetools query total).
 * POST: years=1|2|3&maxCount=optional&orderState=optional&paymentState=optional
 */
exports.CountOrders = function () {
    var platformId = resolvePlatform();

    if (!isDataMigrationConnected(platformId)) {
        jsonResponse({ ok: false, error: 'Not connected to source platform' });
        return;
    }

    var years        = parseInt(getParam('years') || '1', 10);
    var maxRaw       = getParam('maxCount') || '';
    var maxCount     = maxRaw ? parseInt(maxRaw, 10) : null;
    var orderState   = getParam('orderState') || '';
    var paymentState = getParam('paymentState') || '';

    if ([1, 2, 3].indexOf(years) < 0) {
        jsonResponse({ ok: false, error: 'Years must be 1, 2, or 3' });
        return;
    }

    if (!migrationData.isValidOrderState(platformId, orderState)
        || !migrationData.isValidPaymentState(platformId, paymentState)) {
        jsonResponse({ ok: false, error: 'Invalid order or payment state filter' });
        return;
    }

    try {
        var orderConnector = getMigrationFetcher('order');
        var counts = orderConnector.countOrders({
            years:        years,
            maxCount:     maxCount,
            orderState:   orderState,
            paymentState: paymentState
        });

        jsonResponse({
            ok:          true,
            total:       counts.total,
            exportCount: counts.exportCount
        });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CountOrders.public = true;

exports.CheckOrderAttributes = function () {
    try {
        var checker = require('*/cartridge/scripts/migration/orders/orderAttrChecker');
        // runner.checkMissing uses Shopify metafields when platform is shopify
        respondCheckAttributes(checker.checkMissingAttributes());
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckOrderAttributes.public = true;

exports.CreateOrderAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var checker = require('*/cartridge/scripts/migration/orders/orderAttrChecker');
        respondCreateAttributes('order', function (a) { return checker.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateOrderAttributes.public = true;

/**
 * Download a generated migration file from IMPEX/src/migration/.
 * GET: path=src/migration/{runId}/src/orders/orders_001.xml
 */
exports.DownloadMigrationFile = function () {
    var File = require('dw/io/File');
    var relPath = getParam('path');

    if (!relPath || relPath.indexOf('..') >= 0 || relPath.indexOf('src/migration/') !== 0) {
        response.setStatus(400);
        response.writer.print('Invalid path');
        return;
    }

    var file = new File(File.IMPEX + File.SEPARATOR + relPath);
    if (!file.exists() || !file.isFile()) {
        response.setStatus(404);
        response.writer.print('File not found');
        return;
    }

    var fileName = file.getName();
    var isZip    = fileName.indexOf('.zip') === fileName.length - 4;
    response.setContentType(isZip ? 'application/zip' : 'application/xml');
    response.setHttpHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');

    var fis = new Packages.java.io.FileInputStream(file.fullPath);
    try {
        Packages.org.apache.commons.io.IOUtils.copy(fis, response.base.getOutputStream());
    } finally {
        fis.close();
    }
};
exports.DownloadMigrationFile.public = true;

/**
 * Data migration wizard — connect, select type, then type-specific steps.
 */
exports.DataWizard = function () {
    var params       = request.httpParameterMap;
    var platformId   = String((params.platform && params.platform.stringValue) || 'commercetools');
    var stepParam    = 1;
    var typeParam    = getParam('type');

    if (params.step && params.step.submitted) {
        var parsed = parseInt(String(params.step.stringValue || '1'), 10);
        if (parsed > 0) stepParam = parsed;
    }

    if (typeParam) {
        session.custom.selectedDataType = typeParam;
    } else if (stepParam <= 2) {
        delete session.custom.selectedDataType;
    }

    var platform = migrationData.getPlatform(platformId);
    if (!platform || platform.status !== 'ready') {
        response.redirect(URLUtils.url('Accelerator-Start'));
        return;
    }

    var dataTypeId  = String(session.custom.selectedDataType || typeParam || '');
    var maxStep     = migrationData.getMaxDataStep(dataTypeId);
    var currentStep = parseInt(String(Math.min(Math.max(stepParam, 1), maxStep)), 10);
    var wizardStep  = migrationData.getDataWizardStep(currentStep, dataTypeId);
    var prevStep    = currentStep > 1 ? currentStep - 1 : null;
    var nextStep    = currentStep < maxStep ? currentStep + 1 : null;

    session.custom.migrationPlatformId = platformId;

    if (currentStep === 1 && dataMigrationSession.isConnected(platformId)) {
        response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '2'));
        return;
    }

    if (currentStep > 1 && !dataMigrationSession.isConnected(platformId)) {
        response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '1'));
        return;
    }

    if (currentStep > 2 && !dataTypeId) {
        response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '2'));
        return;
    }

    // Types with dedicated migration pages redirect directly at step 3.
    if (currentStep > 2 && dataTypeId === 'customer') {
        response.redirect(URLUtils.url('Accelerator-CustomerMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'shippingMethod') {
        response.redirect(URLUtils.url('Accelerator-ShippingMethodMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'inventory') {
        response.redirect(URLUtils.url('Accelerator-InventoryMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'pricebook') {
        response.redirect(URLUtils.url('Accelerator-PricebookMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'taxation') {
        response.redirect(URLUtils.url('Accelerator-TaxMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'store') {
        response.redirect(URLUtils.url('Accelerator-StoreMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'product') {
        response.redirect(URLUtils.url('Accelerator-ProductWizard'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'catalog') {
        response.redirect(URLUtils.url('Accelerator-CategoryMigration'));
        return;
    }
    if (currentStep > 2 && dataTypeId === 'order') {
        response.redirect(URLUtils.url('Accelerator-OrderMigration'));
        return;
    }

    if (currentStep > 2 && wizardStep.key !== 'typePlaceholder') {
        response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '3'));
        return;
    }

    var stepContent = null;
    if (wizardStep.key === 'selectType') {
        stepContent = migrationData.buildDataSelectContent();
        // Force product and customer selectable regardless of cached migrationData status
        var readyCount = 0;
        for (var si = 0; si < stepContent.sections.length; si++) {
            var sec = stepContent.sections[si];
            if (sec.taskId === 'product' || sec.taskId === 'customer' || sec.taskId === 'order'
                || sec.taskId === 'catalog' || sec.taskId === 'shippingMethod' || sec.taskId === 'inventory'
                || sec.taskId === 'pricebook' || sec.taskId === 'taxation' || sec.taskId === 'store') {
                sec.selectable = true;
            }
            if (sec.selectable) readyCount++;
        }
        stepContent.summary = readyCount + ' data type(s) ready';
    }

    var dataWizardMsgs = {
        connectionFailed:       Resource.msg('accelerator.datawizard.connectionFailed', 'accelerator', null),
        connectionSuccess:      Resource.msg('accelerator.datawizard.connectionSuccess', 'accelerator', null),
        selectTypeCountSuffix:  Resource.msg('accelerator.datawizard.selectType.countSuffix', 'accelerator', null),
        selectTypeNoneSelected: Resource.msg('accelerator.datawizard.selectType.noneSelected', 'accelerator', null)
    };

    var wizardBaseUrl = URLUtils.url('Accelerator-DataWizard', 'platform', platform.id).toString();

    var dataWizardPages = {
        connect:        'accelerator/dataWizardConnect',
        selectType:     'accelerator/dataWizardSelectType',
        typePlaceholder:'accelerator/dataWizardTypePlaceholder'
    };

    var diagParam = getParam('diag');
    var pageTemplate = dataWizardPages[wizardStep.key] || dataWizardPages.typePlaceholder;
    if (diagParam === 'shell') {
        pageTemplate = 'accelerator/dataWizardDiag';
    }

    ISML.renderTemplate(pageTemplate, withBmFrame({
        title:               Resource.msg('accelerator.datawizard.title', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        platform:            platform,
        dataTypeId:          dataTypeId,
        dataType:            migrationData.getDataType(dataTypeId),
        wizardSteps:         migrationData.getDataWizardSteps(dataTypeId),
        currentStep:         currentStep,
        wizardStep:          wizardStep,
        wizardStepKey:       String(wizardStep.key),
        stepContent:         stepContent,
        msgConnectionFailed:      dataWizardMsgs.connectionFailed,
        msgConnectionSuccess:     dataWizardMsgs.connectionSuccess,
        msgSelectTypeCountSuffix: dataWizardMsgs.selectTypeCountSuffix,
        msgSelectTypeNoneSelected: dataWizardMsgs.selectTypeNoneSelected,
        prevStep:            prevStep,
        nextStep:            nextStep,
        prevStepQuery:       toStepQuery(prevStep),
        nextStepQuery:       toStepQuery(nextStep),
        isLastStep:          currentStep >= maxStep,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        dataWizardSelectUrl: dataMigrationSession.dataWizardSelectUrl(platformId),
        hideDataSelectionBack: wizardStep.key === 'connect' || wizardStep.key === 'selectType',
        dataWizardEntryUrl:  dataMigrationSession.dataWizardUrl(platformId),
        wizardBaseUrl:       wizardBaseUrl,
        continueUrl:         URLUtils.url('Accelerator-DataWizardContinue').toString(),
        selectTypeUrl:       URLUtils.url('Accelerator-DataWizardSelectType', 'platform', platformId).toString(),
        testConnectionUrl:   URLUtils.url('Accelerator-TestConnection').toString(),
        connectionSummary:   buildConnectionSummary(platformId),
        categoryMigrationUrl: URLUtils.url('Accelerator-CategoryMigration').toString(),
        dataWizardJsUrl:     URLUtils.staticURL('/js/data-wizard.js').toString() + '?v=4',
        migrationUi:         migrationData.getMigrationUi(platformId),
        migrationUiJson:     migrationData.getMigrationUiJson(platformId),
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString()
    }));
};
exports.DataWizard.public = true;

/**
 * Validate connection on Continue (form POST) and advance to data type selection.
 */
exports.DataWizardContinue = function () {
    var platformId = getParam('platformId') || getParam('platform') || 'commercetools';
    var connector  = registry.get(platformId);
    var stepOneUrl = URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '1');
    var stepTwoUrl = URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '2');

    if (!connector) {
        response.redirect(stepOneUrl);
        return;
    }

    try {
        var summary = buildConnectionSummary(platformId);
        if (!summary.configured) {
            dataMigrationSession.clearConnection();
            response.redirect(stepOneUrl);
            return;
        }
        var result = connector.testConnectionWith(buildConnectionCreds(platformId));
        dataMigrationSession.markConnected(platformId, result.expiresIn);
        response.redirect(stepTwoUrl);
    } catch (e) {
        dataMigrationSession.clearConnection();
        response.redirect(stepOneUrl);
    }
};
exports.DataWizardContinue.public = true;

/**
 * Select a data type and advance into its migration steps.
 */
exports.DataWizardSelectType = function () {
    var platformId = getParam('platform') || resolvePlatform();
    var typeId     = getParam('type');

    if (!isDataMigrationConnected(platformId)) {
        response.redirect(URLUtils.url(
            'Accelerator-DataWizard',
            'platform', platformId,
            'step', dataMigrationSession.connectOrSelectStep(platformId)
        ));
        return;
    }

    if (!migrationData.getDataType(typeId)) {
        response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '2'));
        return;
    }

    session.custom.selectedDataType = typeId;

    // Types with dedicated migration pages bypass the typePlaceholder and go directly.
    if (typeId === 'customer') {
        response.redirect(URLUtils.url('Accelerator-CustomerMigration'));
        return;
    }
    if (typeId === 'shippingMethod') {
        response.redirect(URLUtils.url('Accelerator-ShippingMethodMigration'));
        return;
    }
    if (typeId === 'inventory') {
        response.redirect(URLUtils.url('Accelerator-InventoryMigration'));
        return;
    }
    if (typeId === 'pricebook') {
        response.redirect(URLUtils.url('Accelerator-PricebookMigration'));
        return;
    }
    if (typeId === 'taxation') {
        response.redirect(URLUtils.url('Accelerator-TaxMigration'));
        return;
    }
    if (typeId === 'store') {
        response.redirect(URLUtils.url('Accelerator-StoreMigration'));
        return;
    }
    if (typeId === 'product') {
        response.redirect(URLUtils.url('Accelerator-ProductWizard'));
        return;
    }
    if (typeId === 'catalog') {
        response.redirect(URLUtils.url('Accelerator-CategoryMigration', 'platform', platformId));
        return;
    }
    if (typeId === 'order') {
        response.redirect(URLUtils.url('Accelerator-OrderMigration'));
        return;
    }

    response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '3'));
};
exports.DataWizardSelectType.public = true;

/**
 * Placeholder for data migration flows not yet implemented.
 */
exports.DataMigrationFlow = function () {
    var platformId = getParam('platform') || resolvePlatform();
    var typeId     = getParam('type');

    if (!isDataMigrationConnected(platformId)) {
        response.redirect(URLUtils.url(
            'Accelerator-DataWizard',
            'platform', platformId,
            'step', dataMigrationSession.connectOrSelectStep(platformId)
        ));
        return;
    }

    if (typeId) {
        session.custom.selectedDataType = typeId;
    }

    response.redirect(URLUtils.url('Accelerator-DataWizard', 'platform', platformId, 'step', '3'));
};
exports.DataMigrationFlow.public = true;

// ─── Customer data migration ──────────────────────────────────────────────────

/**
 * Customer migration page — standalone data migration module.
 */
exports.CustomerMigration = function () {
    var cfg2           = require('*/cartridge/scripts/migration/configAccessor');
    var customerListId = (cfg2.sfcc && cfg2.sfcc.customerListId) ? cfg2.sfcc.customerListId : '';
    var platformId = resolvePlatform();
    var isShopify      = platformId === 'shopify';
    var isBigCommerce  = platformId === 'bigcommerce';
    var pageCtx    = migrationPageContext(platformId, 'customer');
    var listsUrl   = URLUtils.url('Accelerator-GetCustomerLists').toString();

    clearModuleAttrIdMap('customer');

    var sourceIdLabel;
    var sourceIdPlaceholder;
    var sourceIdFormatNote;
    if (isShopify) {
        sourceIdLabel       = 'Shopify Customer ID(s)';
        sourceIdPlaceholder = 'e.g. 8474509455577, 8474509619417, ...';
        sourceIdFormatNote  = 'Enter the numeric Shopify customer ID(s) shown in the Shopify admin URL for each customer.';
    } else if (isBigCommerce) {
        sourceIdLabel       = 'BigCommerce Customer ID(s)';
        sourceIdPlaceholder = 'e.g. 1, 2, 15, ...';
        sourceIdFormatNote  = 'Enter the numeric BigCommerce customer ID(s) from the Customers admin for each customer.';
    } else {
        sourceIdLabel       = 'Commercetools Customer UUID(s)';
        sourceIdPlaceholder = 'e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890, ...';
        sourceIdFormatNote  = 'Enter the UUID(s) from the Commercetools platform (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).';
    }

    ISML.renderTemplate('accelerator/customerMigration', withBmFrame({
        title:          Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:       Resource.msg('accelerator.subtitle', 'accelerator', null),
        isShopify:      isShopify,
        isBigCommerce:  isBigCommerce,
        platformLabel:  pageCtx.sourceLabel,
        sourceIdLabel:  sourceIdLabel,
        sourceIdPlaceholder: sourceIdPlaceholder,
        sourceIdFormatNote:  sourceIdFormatNote,
        customerListId: customerListId,
        dashboardUrl:   URLUtils.url('Accelerator-Start').toString(),
        impexPath:      pageCtx.impexPath,
        impexUrl:       pageCtx.impexUrl,
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        dataWizardEntryUrlJs: toJsLiteral(pageCtx.dataWizardEntryUrl),
        customerListsUrlJs:   toJsLiteral(listsUrl),
        presetListIdJs:       toJsLiteral(customerListId),
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        countUrl:       URLUtils.url('Accelerator-CustomerMigrationCount').toString(),
        profileUrl:     URLUtils.url('Accelerator-MigrateCustomerBatch').toString(),
        addressUrl:     URLUtils.url('Accelerator-MigrateCustomerAddresses').toString(),
        fullBatchUrl:        URLUtils.url('Accelerator-FullMigrationBuildBatch').toString(),
        byIdUrl:             URLUtils.url('Accelerator-MigrateCustomerById').toString(),
        customerListsUrl:    listsUrl,
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckCustomerAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreateCustomerAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('customer'),
        deleteAttrUrl:       URLUtils.url('Accelerator-DeleteCustomerAttribute').toString(),
        fetchGroupsUrl:      URLUtils.url('Accelerator-FetchCtpCustomerGroups').toString(),
        createGroupsUrl:     URLUtils.url('Accelerator-CreateSfccCustomerGroups').toString()
    }));
};
exports.CustomerMigration.public = true;

/**
 * Return all SFCC customer list IDs available on the instance.
 * GET — no params required.
 */
exports.GetCustomerLists = function () {
    try {
        var sfccClientSites = require('*/cartridge/scripts/migration/sfccClient');
        var token           = sfccClientSites.getSFCCToken();
        var s               = sfccClientSites.getSFCCSettings();
        var url             = s.baseUrl + '/s/-/dw/data/' + s.metaVersion
                            + '/sites?client_id=' + encodeURIComponent(s.bmClientId);
        var res             = sfccClientSites.doGet(url, token);

        if (res.status !== 200) {
            jsonResponse({ ok: false, error: 'HTTP ' + res.status });
            return;
        }

        var seen   = {};
        var result = [];
        var data   = (res.data && res.data.data) ? res.data.data : [];
        for (var i = 0; i < data.length; i++) {
            var site   = data[i];
            var link   = site.customer_list_link;
            var listId = (link && link.customer_list_id)
                      || site.customer_list_id
                      || site.id;
            if (listId && !seen[listId]) {
                seen[listId] = true;
                result.push({ id: listId });
            }
        }
        jsonResponse({ ok: true, lists: result });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetCustomerLists.public = true;

/**
 * Fetch all customer groups from the source platform and return as JSON.
 * CT: actual customer groups. Shopify: derived from distinct customer tags.
 */
exports.FetchCtpCustomerGroups = function () {
    try {
        var platform = resolvePlatform();
        var groupFetcher;
        if (platform === 'shopify') {
            groupFetcher = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerGroupFetcher');
        } else if (platform === 'bigcommerce') {
            groupFetcher = require('*/cartridge/scripts/migration/customerMigration/bcCustomerGroupFetcher');
        } else {
            groupFetcher = require('*/cartridge/scripts/migration/customerMigration/ctpCustomerGroupFetcher');
        }
        jsonResponse({ ok: true, groups: groupFetcher.fetchGroups() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FetchCtpCustomerGroups.public = true;

/**
 * Create selected CT customer groups in SFCC (keeps exact CT UUID as group ID).
 * POST body: groups=[{"id":"...","name":"..."},...]
 */
exports.CreateSfccCustomerGroups = function () {
    var raw = getParam('groups');
    if (!raw) { jsonResponse({ ok: false, error: 'groups param is required' }); return; }
    try {
        var groups      = JSON.parse(raw);
        var groupWriter = require('*/cartridge/scripts/migration/customerMigration/sfccCustomerGroupWriter');
        jsonResponse({ ok: true, result: groupWriter.ensureGroups(groups) });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateSfccCustomerGroups.public = true;

/**
 * Return all SFCC catalog IDs available on the instance.
 * GET — no params required.
 */
exports.GetProductCatalogs = function () {
    exports.FetchSFCCCatalogs();
};
exports.GetProductCatalogs.public = true;

/**
 * GET: fileName=<name> — streams XML file from IMPEX as a download.
 */
exports.DownloadProductXml = function () {
    var fileName = getParam('fileName') || '';
    if (!fileName || !/^[a-zA-Z0-9_\-]+\.xml$/.test(fileName)) {
        response.setContentType('text/plain');
        response.writer.print('Invalid or missing fileName parameter.');
        return;
    }
    var File       = require('dw/io/File');
    var FileReader = require('dw/io/FileReader');
    var sep        = File.SEPARATOR;
    var file       = new File(File.IMPEX + sep + 'src' + sep + 'migration' + sep + 'product' + sep + fileName);
    if (!file.exists()) {
        response.setContentType('text/plain');
        response.writer.print('File not found: ' + fileName);
        return;
    }
    response.setContentType('application/xml');
    response.addHttpHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    var reader = new FileReader(file, 'UTF-8');
    try {
        var line;
        while ((line = reader.readLine()) !== null) {
            response.writer.println(line);
        }
    } finally {
        reader.close();
    }
};
exports.DownloadProductXml.public = true;

/**
 * GET — Returns all CT variant product attributes plus the saved selection from session.
 * Response: { ok, attrs: [{ name, sfccId, label, ctpType }], savedSelection: [string]|null }
 */
/**
 * GET — Returns product types detected as Product Sets, with product count per type.
 * For Shopify, returns empty (set detection uses productType field at transform time).
 * Response: { ok, sets: [{ typeId, typeName, refAttrName, count }] }
 */
exports.GetProductSetsInfo = function () {
    var platform = String(session.custom.migrationPlatformId || 'commercetools');
    if (platform === 'shopify') {
        jsonResponse({ ok: true, sets: [], note: 'Shopify set/bundle detection uses the Product Type field at migration time.' });
        return;
    }
    if (platform === 'bigcommerce') {
        jsonResponse({ ok: true, sets: [], note: 'BigCommerce product set detection is not yet implemented.' });
        return;
    }
    if (platform === 'sap') {
        jsonResponse({ ok: true, sets: [], note: 'SAP Commerce product set detection is not yet implemented (planned for a later phase).' });
        return;
    }
    try {
        var scanner = require('*/cartridge/scripts/migration/productMigration/ctpProductTypeScanner');
        jsonResponse({ ok: true, sets: scanner.getProductSetsSummary() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetProductSetsInfo.public = true;

/**
 * GET — Returns product types detected as Bundle Products, with product count per type.
 * For Shopify, returns empty (bundle detection uses productType field at transform time).
 * Response: { ok, bundles: [{ typeId, typeName, refAttrName, quantityAttrName, count }] }
 */
exports.GetBundleProductsInfo = function () {
    var platform = String(session.custom.migrationPlatformId || 'commercetools');
    if (platform === 'shopify') {
        jsonResponse({ ok: true, bundles: [], note: 'Shopify set/bundle detection uses the Product Type field at migration time.' });
        return;
    }
    if (platform === 'bigcommerce') {
        jsonResponse({ ok: true, bundles: [], note: 'BigCommerce bundle detection is not yet implemented.' });
        return;
    }
    if (platform === 'sap') {
        jsonResponse({ ok: true, bundles: [], note: 'SAP Commerce bundle detection is not yet implemented (planned for a later phase).' });
        return;
    }
    try {
        var scanner = require('*/cartridge/scripts/migration/productMigration/ctpProductTypeScanner');
        jsonResponse({ ok: true, bundles: scanner.getBundleProductsSummary() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetBundleProductsInfo.public = true;

exports.GetVariantAttrs = function () {
    var platform = String(session.custom.migrationPlatformId || 'commercetools');
    try {
        var sfccClient       = require('*/cartridge/scripts/migration/sfccClient');
        var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
        var attrMap          = attrIdMapSession.read('product');
        var fields           = [];
        var isShopify        = platform === 'shopify';
        var isBigCommerce    = platform === 'bigcommerce';

        if (isShopify) {
            var shopifyChecker = require('*/cartridge/scripts/migration/productMigration/shopifyProductAttrChecker');
            fields = shopifyChecker.getShopifyVariantOptionFields();
        } else if (isBigCommerce) {
            var bcChecker = require('*/cartridge/scripts/migration/productMigration/bcProductAttrChecker');
            fields = bcChecker.getBcVariantOptionFields();
        } else if (platform === 'sap') {
            var sapChecker = require('*/cartridge/scripts/migration/productMigration/sapProductAttrChecker');
            fields = sapChecker.getSapVariantOptionFields();
        } else {
            var checker = require('*/cartridge/scripts/migration/productMigration/productAttrChecker');
            fields = checker.getCtpProductTypeFields();
        }

        var existingIds = {};
        try {
            var tok     = sfccClient.getSFCCToken();
            existingIds = sfccClient.getExistingAttributeIds(tok, 'Product') || {};
        } catch (se) {}

        var enriched = [];
        for (var i = 0; i < fields.length; i++) {
            var f            = fields[i];
            var canonicalId  = f.sfccId;
            var resolvedId   = attrIdMapSession.resolve(canonicalId, attrMap);
            var remapped     = !!(resolvedId && canonicalId && resolvedId !== canonicalId);
            enriched.push({
                name:           f.name,
                sfccId:         resolvedId,
                originalSfccId: canonicalId,
                remapped:       remapped,
                label:          f.label,
                ctpType:        f.ctpType,
                existsInSfcc:   !!existingIds[resolvedId]
            });
        }

        var savedRaw       = String(session.custom.selectedVariantAttrs || '');
        var savedSelection = null;
        if (savedRaw) {
            try { savedSelection = JSON.parse(savedRaw); } catch (pe) {}
        }
        jsonResponse({
            ok:             true,
            attrs:          enriched,
            savedSelection: savedSelection,
            shopify:        isShopify,
            bigcommerce:    isBigCommerce
        });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetVariantAttrs.public = true;

/**
 * POST: attrs=<JSON array of SFCC attr IDs authorized by the user in the pre-flight panel>
 * Saves the pre-flight authorization list to session. No attribute creation happens here.
 */
exports.SavePreflightSelection = function () {
    try {
        var attrsJson = getParam('attrs');
        var attrs = [];
        if (attrsJson) { try { attrs = JSON.parse(attrsJson); } catch (pe) {} }
        session.custom.preflightSelection = JSON.stringify(attrs);
        jsonResponse({ ok: true, authorized: attrs.length });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.SavePreflightSelection.public = true;

/**
 * POST: attrs=<JSON array of CT attr names to include in variant XML>
 * Validates, auto-creates missing SFCC attrs (if pre-flight authorized), then saves selection.
 *
 * Rules:
 *  - Attr exists in SFCC → include directly, no pre-flight needed
 *  - Attr missing in SFCC + pre-flight authorized → create it, then include
 *  - Attr missing in SFCC + NOT pre-flight authorized → validation error
 */
exports.SaveVariantAttrSelection = function () {
    try {
        var attrsJson = getParam('attrs');
        var selected  = [];
        if (attrsJson) { try { selected = JSON.parse(attrsJson); } catch (pe) {} }

        var platform = String(session.custom.migrationPlatformId || 'commercetools');
        var sfccClient = require('*/cartridge/scripts/migration/sfccClient');
        var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
        var attrMap    = attrIdMapSession.read('product');

        // Build sourceName → field map
        var ctpNameToField = {};
        if (platform === 'shopify') {
            var shopifyChecker = require('*/cartridge/scripts/migration/productMigration/shopifyProductAttrChecker');
            var shopifyFields  = shopifyChecker.getShopifyVariantOptionFields();
            for (var sfi = 0; sfi < shopifyFields.length; sfi++) {
                ctpNameToField[shopifyFields[sfi].name] = shopifyFields[sfi];
            }
        } else if (platform === 'bigcommerce') {
            var bcVarChecker = require('*/cartridge/scripts/migration/productMigration/bcProductAttrChecker');
            var bcFields     = bcVarChecker.getBcVariantOptionFields();
            for (var bfi = 0; bfi < bcFields.length; bfi++) {
                ctpNameToField[bcFields[bfi].name] = bcFields[bfi];
            }
        } else {
            var checker    = require('*/cartridge/scripts/migration/productMigration/productAttrChecker');
            var ctpFields  = checker.getCtpProductTypeFields();
            for (var fi = 0; fi < ctpFields.length; fi++) {
                ctpNameToField[ctpFields[fi].name] = ctpFields[fi];
            }
        }

        // Check which attrs currently exist in SFCC (best-effort — if OCAPI fails, skip validation)
        var existingIds = null;
        try {
            var tok = sfccClient.getSFCCToken();
            existingIds = sfccClient.getExistingAttributeIds(tok, 'Product') || {};
        } catch (se) {}

        // Validate only when OCAPI call succeeded (existingIds is not null)
        if (existingIds !== null && Object.keys(existingIds).length > 0) {
            var notInSfcc = [];
            for (var si = 0; si < selected.length; si++) {
                var field = ctpNameToField[selected[si]];
                if (!field) continue;
                var resolvedSfccId = attrIdMapSession.resolve(field.sfccId, attrMap);
                if (!existingIds[resolvedSfccId]) {
                    notInSfcc.push(selected[si]);
                }
            }
            if (notInSfcc.length) {
                jsonResponse({ ok: false, validationError: true, notInSfcc: notInSfcc });
                return;
            }
        }

        session.custom.selectedVariantAttrs = JSON.stringify(selected);
        jsonResponse({ ok: true });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.SaveVariantAttrSelection.public = true;

/**
 * Compare CT customer custom fields against SFCC Customer attribute definitions.
 * Returns attributes present in CT but missing in SFCC.
 * GET — no params required.
 */
exports.CheckCustomerAttributes = function () {
    try {
        var platform = resolvePlatform();
        var checker;
        if (platform === 'shopify') {
            checker = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerAttrChecker');
        } else if (platform === 'bigcommerce') {
            checker = require('*/cartridge/scripts/migration/customerMigration/bcCustomerAttrChecker');
        } else {
            checker = require('*/cartridge/scripts/migration/customerMigration/customerAttrChecker');
        }
        respondCheckAttributes(checker.checkMissingAttributes());
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckCustomerAttributes.public = true;

/**
 * Create selected attribute definitions on the SFCC Customer system object.
 * POST: attrs=<json-array of {id, label, sfccType}>
 */
exports.CreateCustomerAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var platform = resolvePlatform();
        var checker2;
        if (platform === 'shopify') {
            checker2 = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerAttrChecker');
        } else if (platform === 'bigcommerce') {
            checker2 = require('*/cartridge/scripts/migration/customerMigration/bcCustomerAttrChecker');
        } else {
            checker2 = require('*/cartridge/scripts/migration/customerMigration/customerAttrChecker');
        }
        respondCreateAttributes('customer', function (a) { return checker2.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateCustomerAttributes.public = true;

/**
 * Delete a single custom attribute definition from the SFCC Profile system object.
 * POST: attrId=<attribute-id>
 */
exports.DeleteCustomerAttribute = function () {
    var attrId = getParam('attrId');
    if (!attrId) {
        jsonResponse({ ok: false, error: 'attrId is required' });
        return;
    }
    try {
        var sfccClientDel = require('*/cartridge/scripts/migration/sfccClient');
        var tokenDel      = sfccClientDel.getSFCCToken();
        sfccClientDel.deleteAttributeDefinition(tokenDel, 'Profile', attrId);
        jsonResponse({ ok: true });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.DeleteCustomerAttribute.public = true;

/**
 * Return the total number of customers in the CT project.
 * GET/POST — no params required.
 */
exports.CustomerMigrationCount = function () {
    try {
        var platform = resolvePlatform();
        var countFetcher;
        if (platform === 'shopify') {
            countFetcher = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerFetcher');
        } else if (platform === 'bigcommerce') {
            countFetcher = require('*/cartridge/scripts/migration/customerMigration/bcCustomerFetcher');
        } else {
            countFetcher = require('*/cartridge/scripts/migration/customerMigration/ctpCustomerFetcher');
        }
        jsonResponse({ ok: true, total: countFetcher.getCount() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CustomerMigrationCount.public = true;

/**
 * Migrate one batch of customer profiles from CT to SFCC.
 * POST: offset=<n>&listId=<sfcc-customer-list-id>&lastId=<ctp-uuid>
 * Response includes mappings[] for the caller to drive phase 2 (address migration).
 */
exports.MigrateCustomerBatch = function () {
    var offset = parseInt(getParam('offset') || '0', 10);
    var listId = getParam('listId');
    var lastId = getParam('lastId') || '';

    if (!listId) {
        jsonResponse({ ok: false, error: 'listId parameter is required' });
        return;
    }
    if (resolvePlatform() === 'shopify') {
        jsonResponse({
            ok:    false,
            error: 'Sequential partial migration is not supported for Shopify yet — '
                 + 'enter specific customer IDs above, or use Full Migration for the whole store.'
        });
        return;
    }
    if (resolvePlatform() === 'bigcommerce') {
        jsonResponse({
            ok:    false,
            error: 'Sequential partial migration is not supported for BigCommerce yet — '
                 + 'enter specific customer IDs above, or use Full Migration for the whole store.'
        });
        return;
    }
    try {
        var custRunner = require('*/cartridge/scripts/migration/customerMigration/customerMigrationRunner');
        jsonResponse(custRunner.runProfileBatch(offset, listId, lastId));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.MigrateCustomerBatch.public = true;

/**
 * Migrate addresses for one already-created SFCC customer.
 * POST: customerNo=<sfcc-no>&listId=<id>&addresses=<json-array>&offset=<n>
 */
exports.MigrateCustomerAddresses = function () {
    var customerNo = getParam('customerNo');
    var listId     = getParam('listId');
    var offset     = parseInt(getParam('offset') || '0', 10);
    var rawAddrs   = getParam('addresses');

    if (!customerNo || !listId) {
        jsonResponse({ ok: false, error: 'customerNo and listId are required' });
        return;
    }

    var addresses = [];
    try {
        addresses = JSON.parse(rawAddrs || '[]');
    } catch (e) {
        jsonResponse({ ok: false, error: 'Invalid addresses JSON' });
        return;
    }

    try {
        var custRunner2 = require('*/cartridge/scripts/migration/customerMigration/customerMigrationRunner');
        jsonResponse(custRunner2.runAddressBatch(customerNo, addresses, listId, offset));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.MigrateCustomerAddresses.public = true;

/**
 * Full Migration — one poll writes a few source pages into a 20k-customer XML part.
 * POST: offset=<n>&listId=<sfcc-customer-list-id>  (offset 0 starts a new run)
 */
exports.FullMigrationBuildBatch = function () {
    var offset = parseInt(getParam('offset') || '0', 10);
    var listId = getParam('listId');

    if (!listId) {
        jsonResponse({ ok: false, error: 'listId is required' });
        return;
    }
    try {
        var platform = resolvePlatform();
        var fullRunner;
        if (platform === 'shopify') {
            fullRunner = require('*/cartridge/scripts/migration/customerMigration/shopifyFullMigrationRunner');
        } else if (platform === 'bigcommerce') {
            fullRunner = require('*/cartridge/scripts/migration/customerMigration/bcFullMigrationRunner');
        } else {
            fullRunner = require('*/cartridge/scripts/migration/customerMigration/fullMigrationRunner');
        }
        jsonResponse(fullRunner.runBatch(offset, listId));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullMigrationBuildBatch.public = true;

/**
 * Partial Migration (ID mode) — migrate one specific customer by CT customer ID.
 * POST: ctpId=<ctp-uuid>&listId=<sfcc-customer-list-id>
 */
exports.MigrateCustomerById = function () {
    var ctpId  = getParam('ctpId');
    var listId = getParam('listId');

    if (!ctpId || !listId) {
        jsonResponse({ ok: false, error: 'ctpId and listId are required' });
        return;
    }
    try {
        var platform = resolvePlatform();
        var byIdRunner;
        if (platform === 'shopify') {
            byIdRunner = require('*/cartridge/scripts/migration/customerMigration/shopifyCustomerMigrationRunner');
        } else if (platform === 'bigcommerce') {
            byIdRunner = require('*/cartridge/scripts/migration/customerMigration/bcCustomerMigrationRunner');
        } else {
            byIdRunner = require('*/cartridge/scripts/migration/customerMigration/customerMigrationRunner');
        }
        jsonResponse(byIdRunner.runProfileBatchById(ctpId, listId));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.MigrateCustomerById.public = true;

// ─── Shipping method data migration ───────────────────────────────────────────

/**
 * Shipping method migration page — IMPEX XML export (connector-agnostic).
 */
exports.ShippingMethodMigration = function () {
    var platformId = resolvePlatform();
    var pageCtx    = migrationPageContext(platformId, 'shippingMethod');
    var bmLinks = require('*/cartridge/scripts/accelerator/bmLinks');
    var jobsUrl = bmLinks.getImportExportUrl();

    clearModuleAttrIdMap('shippingMethod');

    ISML.renderTemplate('accelerator/shippingMethodMigration', withBmFrame({
        title:        Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:     Resource.msg('accelerator.subtitle', 'accelerator', null),
        impexPath:    pageCtx.impexPath,
        dashboardUrl: URLUtils.url('Accelerator-Start').toString(),
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        impexUrl:     pageCtx.impexUrl,
        cssUrl:       URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl: URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        countUrl:          URLUtils.url('Accelerator-ShippingMethodMigrationCount').toString(),
        listMethodsUrl:    URLUtils.url('Accelerator-ListShippingMethods').toString(),
        fullBatchUrl:      URLUtils.url('Accelerator-FullShippingMethodBuildBatch').toString(),
        checkAttrsUrl:     URLUtils.url('Accelerator-CheckShippingMethodAttributes').toString(),
        createAttrsUrl:    URLUtils.url('Accelerator-CreateShippingMethodAttributes').toString(),
        clearAttrMapUrl:   clearAttrMapUrlFor('shippingMethod'),
        deleteAttrUrl:     URLUtils.url('Accelerator-DeleteShippingMethodAttribute').toString(),
        jobsUrl:           jobsUrl
    }));
};
exports.ShippingMethodMigration.public = true;

/**
 * Return all SFCC site IDs available on the instance.
 * GET — no params required.
 */
exports.GetSites = function () {
    try {
        var sfccClientSites = require('*/cartridge/scripts/migration/sfccClient');
        var token           = sfccClientSites.getSFCCToken();
        var s               = sfccClientSites.getSFCCSettings();
        var url             = s.baseUrl + '/s/-/dw/data/' + s.metaVersion
            + '/sites?client_id=' + encodeURIComponent(s.bmClientId);

        var res = sfccClientSites.doGet(url, token);
        if (res.status !== 200) {
            jsonResponse({ ok: false, error: 'HTTP ' + res.status });
            return;
        }

        var result = [];
        var seen   = {};
        var data   = (res.data && res.data.data) || [];
        for (var i = 0; i < data.length; i++) {
            var siteId = data[i].id;
            if (siteId && !seen[siteId]) {
                seen[siteId] = true;
                result.push({ id: siteId });
            }
        }
        jsonResponse({ ok: true, sites: result });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetSites.public = true;

exports.CheckShippingMethodAttributes = function () {
    try {
        var checker = require('*/cartridge/scripts/migration/shippingMethodMigration/shippingMethodAttrChecker');
        respondCheckAttributes(checker.checkMissingAttributes());
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckShippingMethodAttributes.public = true;

exports.CreateShippingMethodAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var checker2 = require('*/cartridge/scripts/migration/shippingMethodMigration/shippingMethodAttrChecker');
        respondCreateAttributes('shippingMethod', function (a) { return checker2.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateShippingMethodAttributes.public = true;

exports.DeleteShippingMethodAttribute = function () {
    var attrId = getParam('attrId');
    if (!attrId) {
        jsonResponse({ ok: false, error: 'attrId is required' });
        return;
    }
    try {
        var sfccClientDel = require('*/cartridge/scripts/migration/sfccClient');
        var tokenDel      = sfccClientDel.getSFCCToken();
        sfccClientDel.deleteAttributeDefinition(tokenDel, 'ShippingMethod', attrId);
        jsonResponse({ ok: true });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.DeleteShippingMethodAttribute.public = true;

exports.ShippingMethodMigrationCount = function () {
    try {
        var fetcher = getMigrationFetcher('shippingMethod');
        jsonResponse({ ok: true, total: fetcher.getCount() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ShippingMethodMigrationCount.public = true;

/**
 * List all CT shipping methods for the migration checklist UI.
 * GET — no params required.
 */
exports.ListShippingMethods = function () {
    try {
        var fetcher     = getMigrationFetcher('shippingMethod');
        var transformer = require('*/cartridge/scripts/migration/shippingMethodMigration/shippingMethodTransformer');
        var batch       = fetcher.fetchAll();
        var list        = [];

        for (var i = 0; i < batch.methods.length; i++) {
            list.push(transformer.toSummary(batch.methods[i]));
        }

        jsonResponse({ ok: true, total: batch.total, methods: list });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ListShippingMethods.public = true;

exports.FullShippingMethodBuildBatch = function () {
    var offset           = parseInt(getParam('offset') || '0', 10);
    var rawKeys          = getParam('keys');
    var rawExportFormats = getParam('exportFormats');

    var keys = null;
    var exportFormats = [];
    if (rawKeys) {
        try { keys = JSON.parse(rawKeys); } catch (e) {
            jsonResponse({ ok: false, error: 'Invalid keys JSON' });
            return;
        }
    }
    if (rawExportFormats) {
        try { exportFormats = JSON.parse(rawExportFormats); } catch (e) {
            jsonResponse({ ok: false, error: 'Invalid exportFormats JSON' });
            return;
        }
    }
    if (!exportFormats || !exportFormats.length) {
        jsonResponse({ ok: false, error: 'No export formats selected' });
        return;
    }

    try {
        var fullRunner = require('*/cartridge/scripts/migration/shippingMethodMigration/fullMigrationRunner');

        if (keys && keys.length) {
            jsonResponse(fullRunner.runBatchWithExportFormats(keys, offset, exportFormats));
        } else {
            jsonResponse(fullRunner.runBatch(offset, exportFormats));
        }
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullShippingMethodBuildBatch.public = true;

// ─── Inventory list data migration ────────────────────────────────────────────

/**
 * Inventory list migration page — mirrors shipping method flow without entity checklist.
 */
exports.InventoryMigration = function () {
    var cfg2           = require('*/cartridge/scripts/migration/configAccessor');
    var bmLinks        = require('*/cartridge/scripts/accelerator/bmLinks');
    var listId         = (cfg2.sfcc && cfg2.sfcc.inventoryListId) ? cfg2.sfcc.inventoryListId : '';
    var platformId     = resolvePlatform();
    var pageCtx        = migrationPageContext(platformId, 'inventory');
    var jobsUrl        = bmLinks.getImportExportUrl();

    clearModuleAttrIdMap('inventory');

    ISML.renderTemplate('accelerator/inventoryMigration', withBmFrame({
        title:               Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        presetListId:        listId,
        impexPath:           pageCtx.impexPath,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        countUrl:            URLUtils.url('Accelerator-InventoryMigrationCount').toString(),
        fullBatchUrl:        URLUtils.url('Accelerator-FullInventoryBuildBatch').toString(),
        supplyChannelsUrl:   URLUtils.url('Accelerator-GetSupplyChannels').toString(),
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckInventoryAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreateInventoryAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('inventory'),
        impexUrl:            pageCtx.impexUrl,
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        inventoryMigrationJsUrl: URLUtils.staticURL('/js/inventory-migration.js').toString() + '?v=9',
        jobsUrl:             jobsUrl
    }));
};
exports.InventoryMigration.public = true;

/**
 * Return CT inventory supply channels for optional filtering.
 * GET — no params required.
 */
exports.GetSupplyChannels = function () {
    try {
        var fetcher = getMigrationFetcher('inventory');
        jsonResponse({ ok: true, channels: fetcher.fetchSupplyChannels() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetSupplyChannels.public = true;

exports.CheckInventoryAttributes = function () {
    try {
        var checker = require('*/cartridge/scripts/migration/inventoryMigration/inventoryAttrChecker');
        respondCheckAttributes(checker.checkMissingAttributes());
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckInventoryAttributes.public = true;

exports.CreateInventoryAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var checker2 = require('*/cartridge/scripts/migration/inventoryMigration/inventoryAttrChecker');
        respondCreateAttributes('inventory', function (a) { return checker2.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateInventoryAttributes.public = true;

exports.DeleteInventoryAttribute = function () {
    var attrId = getParam('attrId');
    if (!attrId) {
        jsonResponse({ ok: false, error: 'attrId is required' });
        return;
    }
    try {
        var sfccClientDel = require('*/cartridge/scripts/migration/sfccClient');
        var tokenDel      = sfccClientDel.getSFCCToken();
        sfccClientDel.deleteAttributeDefinition(tokenDel, 'ProductInventoryRecord', attrId);
        jsonResponse({ ok: true });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.DeleteInventoryAttribute.public = true;

exports.InventoryMigrationCount = function () {
    try {
        var supplyChannelId = getParam('supplyChannelId');
        var ctpFetcher      = getMigrationFetcher('inventory');
        jsonResponse({ ok: true, total: ctpFetcher.getCount(supplyChannelId) });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.InventoryMigrationCount.public = true;

exports.FullInventoryBuildBatch = function () {
    var offset          = parseInt(getParam('offset') || '0', 10);
    var listId          = getParam('listId');
    var supplyChannelId = getParam('supplyChannelId');
    var exportKey       = getParam('exportKey');
    var fileName        = getParam('fileName');
    var aggregate       = getParam('aggregate') === 'true';
    var singleFile      = getParam('singleFile') !== 'false';

    if (!listId) {
        jsonResponse({ ok: false, error: 'listId is required' });
        return;
    }
    if (!exportKey) {
        jsonResponse({ ok: false, error: 'exportKey is required' });
        return;
    }

    try {
        var fullRunner = require('*/cartridge/scripts/migration/inventoryMigration/fullMigrationRunner');
        jsonResponse(fullRunner.runBatch(offset, listId, supplyChannelId, exportKey, fileName, aggregate, singleFile));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullInventoryBuildBatch.public = true;

// ─── Pricebook data migration ─────────────────────────────────────────────────

exports.PricebookMigration = function () {
    var bmLinks        = require('*/cartridge/scripts/accelerator/bmLinks');
    var presetId       = 'list-prices';
    var platformId     = resolvePlatform();
    var pageCtx        = migrationPageContext(platformId, 'pricebook');
    var jobsUrl        = bmLinks.getImportExportUrl();

    clearModuleAttrIdMap('pricebook');

    ISML.renderTemplate('accelerator/pricebookMigration', withBmFrame({
        title:               Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        presetPricebookId:   presetId,
        impexPath:           pageCtx.impexPath,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        countUrl:            URLUtils.url('Accelerator-PricebookMigrationCount').toString(),
        fullBatchUrl:        URLUtils.url('Accelerator-FullPricebookBuildBatch').toString(),
        pricebooksUrl:       URLUtils.url('Accelerator-GetPricebooks').toString(),
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckPricebookAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreatePricebookAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('pricebook'),
        impexUrl:            pageCtx.impexUrl,
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        pricebookMigrationJsUrl: URLUtils.staticURL('/js/pricebook-migration.js').toString() + '?v=9',
        jobsUrl:             jobsUrl
    }));
};
exports.PricebookMigration.public = true;

exports.GetPricebooks = function () {
    response.setContentType('application/json');
    var section = getParam('section') || 'standalone';
    var offset  = parseInt(getParam('offset') || '0', 10);
    var reset   = getParam('reset') === 'true';
    try {
        if (section === 'embedded') {
            var embeddedOnly = getMigrationFetcher('pricebookEmbedded');
            var embResult    = embeddedOnly.discoverEmbeddedStep(offset, reset);
            jsonResponse({
                ok:           true,
                done:         embResult.done,
                nextOffset:   embResult.nextOffset,
                scanned:      embResult.scanned,
                total:        embResult.total,
                productTotal: embResult.productTotal,
                embedded:     embResult.embedded || []
            });
            return;
        }
        var fetcher   = getMigrationFetcher('pricebook');
        var stdResult = fetcher.discoverStandaloneStep(offset, reset);
        jsonResponse({
            ok:         true,
            done:       stdResult.done,
            nextOffset: stdResult.nextOffset,
            scanned:    stdResult.scanned,
            total:      stdResult.total,
            standalone: stdResult.standalone || []
        });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetPricebooks.public = true;

exports.CheckPricebookAttributes = function () {
    try {
        var checker  = require('*/cartridge/scripts/migration/pricebookMigration/pricebookAttrChecker');
        var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
        // Pricebook has no trace-attribute fallback (unlike Store), and SAP has no verified
        // endpoint for discovering custom price fields — so for SAP, zero fields are ever
        // checked.
        var result = checker.checkMissingAttributes();
        if (Array.isArray(result)) {
            result = { missing: result };
        }
        result = result || {};
        result.noDynamicFieldSource = registry.getPlatformId() === 'sap';
        respondCheckAttributes(result);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckPricebookAttributes.public = true;

exports.CreatePricebookAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var checker2 = require('*/cartridge/scripts/migration/pricebookMigration/pricebookAttrChecker');
        respondCreateAttributes('pricebook', function (a) { return checker2.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreatePricebookAttributes.public = true;

exports.PricebookMigrationCount = function () {
    response.setContentType('application/json');
    try {
        var source    = getParam('source') || 'standalone';
        var currency  = getParam('currency');
        var channelId = getParam('channelId');
        var aggregate = getParam('aggregate') === 'true';
        if (source === 'embedded') {
            var embedded = getMigrationFetcher('pricebookEmbedded');
            jsonResponse({ ok: true, total: embedded.getPriceCount(currency, channelId, aggregate) });
            return;
        }
        var fetcher = getMigrationFetcher('pricebook');
        jsonResponse({ ok: true, total: fetcher.getCount(currency, channelId, aggregate) });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.PricebookMigrationCount.public = true;

exports.FullPricebookBuildBatch = function () {
    response.setContentType('application/json');
    var offset       = parseInt(getParam('offset') || '0', 10);
    var pricebookId  = getParam('pricebookId');
    var currency     = getParam('currency');
    var channelId    = getParam('channelId');
    var exportKey    = getParam('exportKey');
    var fileName     = getParam('fileName');
    var aggregate    = getParam('aggregate') === 'true';
    var source       = getParam('source') || 'standalone';
    var singleFile   = getParam('singleFile') !== 'false';

    if (!pricebookId) {
        jsonResponse({ ok: false, error: 'pricebookId is required' });
        return;
    }
    if (!currency) {
        jsonResponse({ ok: false, error: 'currency is required' });
        return;
    }
    if (!exportKey) {
        jsonResponse({ ok: false, error: 'exportKey is required' });
        return;
    }

    try {
        var fullRunner = require('*/cartridge/scripts/migration/pricebookMigration/fullMigrationRunner');
        if (source === 'embedded') {
            jsonResponse(fullRunner.runEmbeddedBatch(
                offset, pricebookId, currency, channelId, exportKey, fileName, aggregate, singleFile
            ));
            return;
        }
        jsonResponse(fullRunner.runBatch(
            offset, pricebookId, currency, channelId, exportKey, fileName, aggregate, singleFile
        ));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullPricebookBuildBatch.public = true;

// ─── Tax data migration ───────────────────────────────────────────────────────

exports.TaxMigration = function () {
    var bmLinks        = require('*/cartridge/scripts/accelerator/bmLinks');
    var platformId     = resolvePlatform();
    var pageCtx        = migrationPageContext(platformId, 'tax');
    var jobsUrl        = bmLinks.getImportExportUrl();

    clearModuleAttrIdMap('tax');

    ISML.renderTemplate('accelerator/taxMigration', withBmFrame({
        title:               Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        impexPath:           pageCtx.impexPath,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        countUrl:            URLUtils.url('Accelerator-TaxMigrationCount').toString(),
        fullBatchUrl:        URLUtils.url('Accelerator-FullTaxBuildBatch').toString(),
        summaryUrl:          URLUtils.url('Accelerator-GetTaxSummary').toString(),
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckTaxAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreateTaxAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('tax'),
        impexUrl:            pageCtx.impexUrl,
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        taxMigrationJsUrl:   URLUtils.staticURL('/js/tax-migration.js').toString() + '?v=10',
        jobsUrl:             jobsUrl
    }));
};
exports.TaxMigration.public = true;

exports.CheckTaxAttributes = function () {
    response.setContentType('application/json');
    try {
        var checker = require('*/cartridge/scripts/migration/taxMigration/taxAttrChecker');
        respondCheckAttributes(checker.checkMissingAttributes());
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckTaxAttributes.public = true;

exports.CreateTaxAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var checker = require('*/cartridge/scripts/migration/taxMigration/taxAttrChecker');
        respondCreateAttributes('tax', function (a) { return checker.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateTaxAttributes.public = true;

exports.GetTaxSummary = function () {
    response.setContentType('application/json');
    try {
        var fetcher = getMigrationFetcher('tax');
        jsonResponse({ ok: true, overview: fetcher.getTaxOverview() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetTaxSummary.public = true;

exports.TaxMigrationCount = function () {
    response.setContentType('application/json');
    try {
        var scopeType = getParam('scopeType') || 'full';
        var scopeId   = getParam('scopeId') || '';
        var fetcher   = getMigrationFetcher('tax');
        jsonResponse({ ok: true, total: fetcher.getRateCount(scopeType, scopeId) });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.TaxMigrationCount.public = true;

exports.FullTaxBuildBatch = function () {
    response.setContentType('application/json');
    var offset     = parseInt(getParam('offset') || '0', 10);
    var exportKey  = getParam('exportKey');
    var scopeType  = getParam('scopeType') || 'full';
    var scopeId    = getParam('scopeId') || '';
    var fileName   = getParam('fileName');
    var singleFile = getParam('singleFile') !== 'false';

    if (!exportKey) {
        jsonResponse({ ok: false, error: 'exportKey is required' });
        return;
    }

    try {
        var fullRunner = require('*/cartridge/scripts/migration/taxMigration/fullMigrationRunner');
        jsonResponse(fullRunner.runBatch(offset, exportKey, scopeType, scopeId, fileName, singleFile));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullTaxBuildBatch.public = true;

// ─── Store data migration ─────────────────────────────────────────────────────

exports.StoreMigration = function () {
    var bmLinks        = require('*/cartridge/scripts/accelerator/bmLinks');
    var platformId     = resolvePlatform();
    var pageCtx        = migrationPageContext(platformId, 'store');
    var jobsUrl        = bmLinks.getImportExportUrl();

    // Track the active platform so AJAX endpoints (e.g. CheckStoreAttributes) can read it from session.
    session.custom.migrationPlatformId = platformId;

    // Attribute rename map is visit-scoped — reset on page load / re-entry.
    clearModuleAttrIdMap('store');

    ISML.renderTemplate('accelerator/storeMigration', withBmFrame({
        title:               Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        impexPath:           pageCtx.impexPath,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        fullBatchUrl:        URLUtils.url('Accelerator-FullStoreBuildBatch').toString(),
        listStoresUrl:       URLUtils.url('Accelerator-ListStores').toString(),
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckStoreAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreateStoreAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('store'),
        impexUrl:            pageCtx.impexUrl,
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        storeMigrationJsUrl: URLUtils.staticURL('/js/store-migration.js').toString() + '?v=11',
        jobsUrl:             jobsUrl
    }));
};
exports.StoreMigration.public = true;

exports.ClearAttrIdMap = function () {
    response.setContentType('application/json');
    try {
        var moduleKey = getParam('module') || '';
        if (!moduleKey) {
            jsonResponse({ ok: false, error: 'module is required' });
            return;
        }
        clearModuleAttrIdMap(moduleKey);
        jsonResponse({ ok: true });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ClearAttrIdMap.public = true;

/**
 * Persist visit-scoped source→SFCC attr remaps (e.g. accept AI suggestion).
 * Body/params: module, attrs=[{ canonicalId|sourceId, id }]
 */
exports.SaveAttrIdMap = function () {
    response.setContentType('application/json');
    try {
        var moduleKey = getParam('module') || '';
        if (!moduleKey) {
            jsonResponse({ ok: false, error: 'module is required' });
            return;
        }
        var attrs = parseAttrsParam();
        if (!attrs) return;
        var attrIdMapSession = require('*/cartridge/scripts/migration/core/attrIdMapSession');
        attrIdMapSession.saveFromAttrs(moduleKey, attrs);
        jsonResponse({ ok: true, mapped: attrs.length });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.SaveAttrIdMap.public = true;

/**
 * OpenAI mapping suggestions for Check Attributes create candidates (async follow-up).
 * Params: task (or sfccObjectType), attrs=[{id,label,sourceType,...}]
 */
exports.SuggestAttrMaps = function () {
    response.setContentType('application/json');
    try {
        var taskName = getParam('task') || getParam('taskName') || '';
        var sfccObjectType = getParam('sfccObjectType') || '';
        if (!taskName && sfccObjectType) {
            taskName = sfccObjectType === 'Profile' ? 'Customer' : sfccObjectType;
        }
        if (!taskName) {
            jsonResponse({ ok: false, error: 'task is required', suggested: [], aiStatus: 'error' });
            return;
        }
        var attrs = parseAttrsParam();
        if (!attrs) return;

        var excludeSfccFields = [];
        try {
            var rawExclude = getParam('excludeSfccFields') || '[]';
            var parsedExclude = JSON.parse(rawExclude);
            if (parsedExclude && parsedExclude.length) {
                excludeSfccFields = parsedExclude;
            }
        } catch (exErr) {
            excludeSfccFields = [];
        }

        var liveSystemAttrs = [];
        if (sfccObjectType) {
            try {
                var sfccClient = require('*/cartridge/scripts/migration/sfccClient');
                var token = sfccClient.getSFCCToken();
                var allAttrs = sfccClient.getAttributeDefinitions(token, sfccObjectType) || [];
                var i;
                for (i = 0; i < allAttrs.length; i++) {
                    if (allAttrs[i] && allAttrs[i].system) {
                        liveSystemAttrs.push({ id: allAttrs[i].id });
                    }
                }
            } catch (liveErr) {
                liveSystemAttrs = [];
            }
        }

        var registry = require('*/cartridge/scripts/migration/core/dataSourceRegistry');
        var attrMapSuggestor = require('*/cartridge/scripts/migration/core/attrMapSuggestor');
        var result = attrMapSuggestor.suggestSystemMaps({
            missing:            attrs,
            taskName:           taskName,
            platformId:         registry.getPlatformId(),
            liveSystemAttrs:    liveSystemAttrs,
            excludeSfccFields:  excludeSfccFields
        });
        jsonResponse({
            ok:        result.aiStatus !== 'error',
            suggested: result.suggested || [],
            aiStatus:  result.aiStatus || 'skipped',
            aiMessage: result.aiMessage || '',
            taskName:  taskName
        });
    } catch (e) {
        jsonResponse({
            ok: false,
            error: e.message || String(e),
            suggested: [],
            aiStatus: 'error',
            aiMessage: e.message || String(e)
        });
    }
};
exports.SuggestAttrMaps.public = true;

/** @deprecated use ClearAttrIdMap?module=store */
exports.ClearStoreAttrMap = function () {
    clearModuleAttrIdMap('store');
    jsonResponse({ ok: true });
};
exports.ClearStoreAttrMap.public = true;

exports.CheckStoreAttributes = function () {
    response.setContentType('application/json');
    try {
        var checker = require('*/cartridge/scripts/migration/storeMigration/storeAttrChecker');
        respondCheckAttributes(checker.checkMissingAttributes());
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckStoreAttributes.public = true;

exports.CreateStoreAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    try {
        var checker = require('*/cartridge/scripts/migration/storeMigration/storeAttrChecker');
        respondCreateAttributes('store', function (a) { return checker.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateStoreAttributes.public = true;

exports.GetStoreSummary = function () {
    response.setContentType('application/json');
    try {
        var fetcher = getMigrationFetcher('store');
        jsonResponse({ ok: true, summary: fetcher.getFullStoreSummary() });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.GetStoreSummary.public = true;

/**
 * List all CT stores for the migration checklist UI.
 * GET — no params required.
 */
exports.ListStores = function () {
    response.setContentType('application/json');
    try {
        var fetcher     = getMigrationFetcher('store');
        var transformer = require('*/cartridge/scripts/migration/storeMigration/storeTransformer');
        var stores      = fetcher.fetchAllCtpStores();
        var list        = [];
        var i;

        for (i = 0; i < stores.length; i++) {
            list.push(transformer.toSummary(stores[i]));
        }

        jsonResponse({ ok: true, total: stores.length, stores: list });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ListStores.public = true;

exports.StoreMigrationCount = function () {
    response.setContentType('application/json');
    try {
        var fetcher = getMigrationFetcher('store');
        var summary = fetcher.getFullStoreSummary();
        jsonResponse({ ok: true, total: summary.storeCount || 0 });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.StoreMigrationCount.public = true;

exports.FullStoreBuildBatch = function () {
    response.setContentType('application/json');
    var offset    = parseInt(getParam('offset') || '0', 10);
    var exportKey = getParam('exportKey') || 'full';
    var fileName  = getParam('fileName');
    var rawKeys    = getParam('keys');
    var singleFile = getParam('singleFile') !== 'false';

    var keys = null;
    if (rawKeys) {
        try { keys = JSON.parse(rawKeys); } catch (e) {
            jsonResponse({ ok: false, error: 'Invalid keys JSON' });
            return;
        }
    }

    try {
        var fullRunner = require('*/cartridge/scripts/migration/storeMigration/fullMigrationRunner');
        jsonResponse(fullRunner.runBatch(offset, exportKey, fileName, keys, singleFile));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullStoreBuildBatch.public = true;

/**
 * Full Migration — trigger the SFCC import job via OCAPI Data API (self-call).
 * POST: jobId=<BM-job-id>
 *
 * Prerequisite: the OCAPI client configured in sfccClient must have the Jobs resource
 * with POST method enabled in Administration → Global Preferences → Open Commerce API Settings.
 */
exports.FullMigrationTriggerJob = function () {
    var jobId = getParam('jobId');
    if (!jobId) {
        jsonResponse({ ok: false, error: 'jobId is required' });
        return;
    }
    try {
        var sfccClient4 = require('*/cartridge/scripts/migration/sfccClient');
        var cfg4        = require('*/cartridge/scripts/migration/configAccessor');
        var token       = sfccClient4.getSFCCToken();
        var version     = (cfg4.sfcc && cfg4.sfcc.metaVersion) || 'v25_6';
        var url4        = 'https://' + request.httpHost
                        + '/s/-/dw/data/' + version + '/jobs/' + encodeURIComponent(jobId) + '/executions';
        var res4 = sfccClient4.doPost(url4, token, {});
        var sc4 = res4.status;
        if (sc4 === 200 || sc4 === 201) {
            var resp4 = res4.data || {};
            jsonResponse({ ok: true, executionId: String(resp4.id || ''), status: String(resp4.status || 'pending') });
        } else {
            jsonResponse({ ok: false, error: 'OCAPI trigger failed (HTTP ' + sc4 + ')' });
        }
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullMigrationTriggerJob.public = true;

/**
 * Full Migration — poll the execution status of an import job.
 * POST: jobId=<BM-job-id>&executionId=<execution-id>
 */
exports.FullMigrationJobStatus = function () {
    var jobId5       = getParam('jobId');
    var executionId5 = getParam('executionId');
    if (!jobId5 || !executionId5) {
        jsonResponse({ ok: false, error: 'jobId and executionId are required' });
        return;
    }
    try {
        var sfccClient5 = require('*/cartridge/scripts/migration/sfccClient');
        var cfg5        = require('*/cartridge/scripts/migration/configAccessor');
        var token5      = sfccClient5.getSFCCToken();
        var version5    = (cfg5.sfcc && cfg5.sfcc.metaVersion) || 'v25_6';
        var url5        = 'https://' + request.httpHost
                        + '/s/-/dw/data/' + version5 + '/jobs/' + encodeURIComponent(jobId5)
                        + '/executions/' + encodeURIComponent(executionId5);
        var res5 = sfccClient5.doGet(url5, token5);
        var sc5 = res5.status;
        if (sc5 === 200) {
            var resp5 = res5.data || {};
            var dur5 = resp5.duration ? Math.round(resp5.duration / 1000) : null;
            jsonResponse({
                ok:       true,
                status:   String(resp5.status || 'unknown'),
                duration: dur5,
                message:  resp5.end_time ? 'Completed at ' + resp5.end_time : null
            });
        } else {
            jsonResponse({ ok: false, error: 'Status check failed (HTTP ' + sc5 + ')' });
        }
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullMigrationJobStatus.public = true;

// ─── Product catalog migration wizard ─────────────────────────────────────────

/**
 * Product migration wizard — 5-step flow: Connect → Fetch → Configure → Move → View.
 * Produces SFCC catalog XML files uploaded via WebDAV, then triggers a BM import job.
 */
exports.ProductWizard = function () {
    var platformId = resolvePlatform();
    var pageCtx    = migrationPageContext(platformId, 'product');

    // Visit-scoped remaps reset on full page load / refresh (same as other modules).
    clearModuleAttrIdMap('product');
    try { session.custom.selectedVariantAttrs = ''; } catch (e1) { /* ignore */ }
    try { session.custom.preflightSelection = ''; } catch (e2) { /* ignore */ }

    ISML.renderTemplate('accelerator/productMigration', withBmFrame({
        title:          Resource.msg('accelerator.title', 'accelerator', null),
        subtitle:       Resource.msg('accelerator.subtitle', 'accelerator', null),
        impexPath:      pageCtx.impexPath,
        impexUrl:       pageCtx.impexUrl,
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        countUrl:       URLUtils.url('Accelerator-ProductMigrationCount').toString(),
        partialUrl:     URLUtils.url('Accelerator-MigrateProductById').toString(),
        fullBatchUrl:   URLUtils.url('Accelerator-FullProductMigrationBuildBatch').toString(),
        checkAttrsUrl:       URLUtils.url('Accelerator-CheckProductAttributes').toString(),
        createAttrsUrl:      URLUtils.url('Accelerator-CreateProductAttributes').toString(),
        clearAttrMapUrl:     clearAttrMapUrlFor('product'),
        deleteAttrUrl:       URLUtils.url('Accelerator-DeleteProductAttribute').toString(),
        catalogsUrl:         URLUtils.url('Accelerator-GetProductCatalogs').toString(),
        downloadXmlUrl:      URLUtils.url('Accelerator-DownloadProductXml').toString(),
        variantAttrsUrl:      URLUtils.url('Accelerator-GetVariantAttrs').toString(),
        saveVariantAttrsUrl:  URLUtils.url('Accelerator-SaveVariantAttrSelection').toString(),
        savePreflightUrl:     URLUtils.url('Accelerator-SavePreflightSelection').toString(),
        productSetsUrl:      URLUtils.url('Accelerator-GetProductSetsInfo').toString(),
        bundleProductsUrl:   URLUtils.url('Accelerator-GetBundleProductsInfo').toString(),
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        attrPreflightJsUrl:  URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12'
    }, 'rc_accelerator_product_wizard'));
};
exports.ProductWizard.public = true;

/**
 * Save product wizard configuration (Step 3) to session.
 * POST: catalogId=<id>&pricebookId=<id>&currency=<code>&inventoryListId=<id>
 */
exports.SaveProdConfig = function () {
    var catalogId       = getParam('catalogId');
    var pricebookId     = getParam('pricebookId')     || 'list-prices';
    var currency        = getParam('currency')         || 'USD';
    var inventoryListId = getParam('inventoryListId')  || 'default-inventory';

    if (!catalogId) {
        jsonResponse({ ok: false, error: 'catalogId is required' });
        return;
    }
    session.custom.prodWizardCatalogId       = catalogId;
    session.custom.prodWizardPricebookId     = pricebookId;
    session.custom.prodWizardCurrency        = currency.toUpperCase();
    session.custom.prodWizardInventoryListId = inventoryListId;
    jsonResponse({ ok: true });
};
exports.SaveProdConfig.public = true;

/**
 * Save product wizard migration results (Step 4) to session for display in Step 5.
 * POST: results=<json>
 */
exports.SaveProdWizardResults = function () {
    var raw = getParam('results');
    if (raw) session.custom.prodWizardResults = raw;
    jsonResponse({ ok: true });
};
exports.SaveProdWizardResults.public = true;

/**
 * Return total number of products in the source platform (CT or Shopify).
 */
exports.ProductMigrationCount = function () {
    var platform = String(session.custom.migrationPlatformId || 'commercetools');
    try {
        if (platform === 'shopify') {
            var shopifyFetcher = require('*/cartridge/scripts/migration/productMigration/shopifyProductFetcher');
            jsonResponse({ ok: true, total: shopifyFetcher.getCount() });
        } else if (platform === 'bigcommerce') {
            var bcFetcherCount = require('*/cartridge/scripts/migration/productMigration/bcProductFetcher');
            jsonResponse({ ok: true, total: bcFetcherCount.getCount() });
        } else if (platform === 'sap') {
            var sapFetcherCount = require('*/cartridge/scripts/migration/productMigration/sapProductFetcher');
            jsonResponse({ ok: true, total: sapFetcherCount.getCount() });
        } else {
            var prodFetcher = require('*/cartridge/scripts/migration/productMigration/ctpProductFetcher');
            jsonResponse({ ok: true, total: prodFetcher.getCount() });
        }
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ProductMigrationCount.public = true;

/**
 * Full Product Migration — fetch one batch of products, build catalog XML, upload via WebDAV.
 * POST: offset=<number> (CT) or offset=<cursor-string> (Shopify, empty/0 = first page)
 * catalogId is read from request param or Site Preferences / defaults (sfcc.catalogId).
 */
exports.FullProductMigrationBuildBatch = function () {
    var platform  = String(session.custom.migrationPlatformId || 'commercetools');
    var offsetRaw = getParam('offset') || '0';

    // For Shopify, offset is a cursor string. For CT/SAP/BC, parse as integer.
    var offsetOrCursor = (platform === 'shopify')
        ? ((offsetRaw === '0' || !offsetRaw) ? null : offsetRaw)
        : parseInt(offsetRaw, 10);

    var migCfg    = require('*/cartridge/scripts/migration/configAccessor');
    var catalogId = getParam('catalogId')
                 || (migCfg.sfcc && migCfg.sfcc.catalogId ? String(migCfg.sfcc.catalogId) : '');

    if (!catalogId) {
        jsonResponse({ ok: false, error: 'sfcc.catalogId is not configured' });
        return;
    }
    var selectedVarAttrs = null;
    try {
        var raw = String(session.custom.selectedVariantAttrs || '');
        if (raw) { selectedVarAttrs = JSON.parse(raw); }
    } catch (pe) {}
    try {
        var prodRunner = require('*/cartridge/scripts/migration/productMigration/fullProductMigrationRunner');
        jsonResponse(prodRunner.runBatch(offsetOrCursor, catalogId, selectedVarAttrs, platform));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FullProductMigrationBuildBatch.public = true;

/**
 * Partial Product Migration — fetch one product by ID, build XML, upload via WebDAV.
 * POST: prodId=<id> (accepts ctpId or shopifyId as aliases)
 *       For CT: UUID. For Shopify: handle, numeric ID, or GID.
 */
exports.MigrateProductById = function () {
    var prodId = getParam('prodId') || getParam('ctpId') || getParam('shopifyId');
    if (!prodId) {
        jsonResponse({ ok: false, error: 'prodId is required' });
        return;
    }
    var platform  = String(session.custom.migrationPlatformId || 'commercetools');
    var migCfg    = require('*/cartridge/scripts/migration/configAccessor');
    var catalogId = getParam('catalogId')
                 || (migCfg.sfcc && migCfg.sfcc.catalogId ? String(migCfg.sfcc.catalogId) : '');
    if (!catalogId) {
        jsonResponse({ ok: false, error: 'sfcc.catalogId is not configured' });
        return;
    }
    var selectedVarAttrs = null;
    try {
        var raw = String(session.custom.selectedVariantAttrs || '');
        if (raw) { selectedVarAttrs = JSON.parse(raw); }
    } catch (pe) {}
    try {
        var prodRunner = require('*/cartridge/scripts/migration/productMigration/fullProductMigrationRunner');
        jsonResponse(prodRunner.runById(prodId, catalogId, selectedVarAttrs, platform));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.MigrateProductById.public = true;

/**
 * Compare source platform product type attributes against SFCC Product attribute definitions.
 * Returns attributes missing in SFCC.
 * GET — no params required.
 */
exports.CheckProductAttributes = function () {
    var platform = String(session.custom.migrationPlatformId || 'commercetools');
    try {
        if (platform === 'shopify') {
            var shopifyChecker = require('*/cartridge/scripts/migration/productMigration/shopifyProductAttrChecker');
            respondCheckAttributes(shopifyChecker.checkMissingAttributes());
        } else if (platform === 'bigcommerce') {
            var bcProdChecker = require('*/cartridge/scripts/migration/productMigration/bcProductAttrChecker');
            respondCheckAttributes(bcProdChecker.checkMissingAttributes());
        } else if (platform === 'sap') {
            var sapChecker = require('*/cartridge/scripts/migration/productMigration/sapProductAttrChecker');
            respondCheckAttributes(sapChecker.checkMissingAttributes());
        } else {
            var checker = require('*/cartridge/scripts/migration/productMigration/productAttrChecker');
            respondCheckAttributes(checker.checkMissingAttributes());
        }
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CheckProductAttributes.public = true;

/**
 * Create selected attribute definitions on the SFCC Product system object.
 * POST: attrs=<json-array of {id, label, sfccType}>
 */
exports.CreateProductAttributes = function () {
    var attrs = parseAttrsParam();
    if (!attrs) return;
    var platform = String(session.custom.migrationPlatformId || 'commercetools');
    try {
        var checker2 = (platform === 'shopify')
            ? require('*/cartridge/scripts/migration/productMigration/shopifyProductAttrChecker')
            : (platform === 'bigcommerce')
                ? require('*/cartridge/scripts/migration/productMigration/bcProductAttrChecker')
                : (platform === 'sap')
                    ? require('*/cartridge/scripts/migration/productMigration/sapProductAttrChecker')
                    : require('*/cartridge/scripts/migration/productMigration/productAttrChecker');
        respondCreateAttributes('product', function (a) { return checker2.createAttributes(a); }, attrs);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateProductAttributes.public = true;

/**
 * Delete a single custom attribute definition from the SFCC Product system object.
 * POST: attrId=<attribute-id>
 */
exports.DeleteProductAttribute = function () {
    var attrId = getParam('attrId');
    if (!attrId) {
        jsonResponse({ ok: false, error: 'attrId is required' });
        return;
    }
    try {
        var sfcc2 = require('*/cartridge/scripts/migration/sfccClient');
        var tok   = sfcc2.getSFCCToken();
        sfcc2.deleteAttributeDefinition(tok, 'Product', attrId);
        jsonResponse({ ok: true });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.DeleteProductAttribute.public = true;

// ─── Category migration ───────────────────────────────────────────────────────

/**
 * Category migration page — renders the category migration UI.
 */


exports.CategoryMigrationJS = function () {
    response.setContentType('application/javascript');
    response.writer.print(getCategoryMigrationJS());
};
exports.CategoryMigrationJS.public = true;

// Paste this function into Accelerator.js
// It returns the full JS as a string served via Accelerator-CategoryMigrationJS


function getCategoryMigrationJS() {
    var L = [];

    L.push('var _APP = {};');
    L.push('_APP.allCategories = [];');
    L.push('_APP.catMap = {};');
    L.push('_APP.hierarchyOverrides = {};');
    L.push('_APP.orderOverrides = {};');
    L.push('_APP.pendingParent = {};');
    L.push('_APP.pendingOrder = {};');
    L.push('_APP.running = false;');
    L.push('_APP.draggingId = null;');
    L.push('_APP.newCatCount = 0;');
    L.push('_APP.addedCats = [];');
    L.push('_APP.activeFilter = "all";');
    L.push('_APP.MIGRATE_URL = "";');
    L.push('_APP.FETCH_URL = "";');
    L.push('_APP.ATTRS_URL = "";');
    L.push('_APP.STATUS_URL = "";');
    L.push('_APP.IMPEX_URL = "";');
    L.push('_APP.FETCH_CATALOGS_URL = "";');
    L.push('_APP.CREATE_CATALOG_URL = "";');
    L.push('_APP.CREATE_CATEGORY_URL = "";');
    L.push('_APP.IMPORT_URL = "";');
    L.push('_APP.productCounts = {};');
    L.push('_APP.selectedForExport = {};');
    L.push('_APP.CHECK_PRODUCTS_URL = "";');
    L.push('_APP.CREATE_ATTRS_URL = "";');

    L.push('_APP.renderAttrTable=function(attrs){');
    L.push('  var Q=String.fromCharCode(34);');
    L.push('  var tbody=document.getElementById("attr-tbody");');
    L.push('  if(!tbody)return;');
    L.push('  var rowHtml="";');
    L.push('  var attrsData=[];');
    L.push('  attrs.forEach(function(attr,i){');
    L.push('    var statusColor=attr.exists?"#2e7d32":"#e65100";');
    L.push('    var statusBg=attr.exists?"#e8f5e9":"#fff3e0";');
    L.push('    var statusText=attr.exists?"Exists":"Missing";');
    L.push('    var chk=!attr.exists?" checked":"";');
    L.push('    var typeHtml=window.AccAttrPreflight?window.AccAttrPreflight.sfccTypeSelectHtml(attr,i):"<code>"+attr.sfccType+"</code>";');
    L.push('    rowHtml+="<tr"+a("data-rowidx",i)+">"');
    L.push('      +"<td style="+Q+"text-align:center;padding:9px 14px;border-bottom:1px solid #f0f2f8;"+Q+">"');
    L.push('      +"<input type="+Q+"checkbox"+Q+a("class","cat-attr-cb")+a("data-idx",i)+a("data-attrid",attr.id)+a("data-attrtype",attr.sfccType)+a("data-attrlabel",attr.label)+a("data-attrexists",attr.exists?"1":"")+chk+a("style","width:16px;height:16px;cursor:pointer;")+"/>"');
    L.push('      +"</td>"');
    L.push('      +"<td style="+Q+"padding:9px 14px;border-bottom:1px solid #f0f2f8;"+Q+">"');
    L.push('      +"<input type="+Q+"text"+Q+a("class","cm-attr-id-input")+a("data-idx",i)+a("data-orig",attr.id)+a("data-canonical",attr.id)+a("value",attr.id)+"/>"');
    L.push('      +"</td>"');
    L.push('      +"<td style="+Q+"padding:9px 14px;border-bottom:1px solid #f0f2f8;"+Q+">"+attr.label+"</td>"');
    L.push('      +"<td style="+Q+"padding:9px 14px;border-bottom:1px solid #f0f2f8;"+Q+">"');
    L.push('      +"<span"+a("class","cat-status-span")+a("data-idx",i)+a("style","background:"+statusBg+";color:"+statusColor+";padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;")+">"+statusText+"</span>"');
    L.push('      +"</td>"');
    L.push('      +"<td style="+Q+"padding:9px 14px;border-bottom:1px solid #f0f2f8;"+Q+">"+typeHtml+"</td>"');
    L.push('      +"<td style="+Q+"padding:9px 14px;border-bottom:1px solid #f0f2f8;"+Q+">"');
    L.push('      +"<button type="+Q+"button"+Q+a("class","cm-btn--revert cat-attr-revert")+a("data-idx",i)+(attr.exists?"":(" disabled"+a("title","Create this attribute first to enable Revert")))+">Revert</button>"');
    L.push('      +"</td>"');
    L.push('      +"</tr>";');
    L.push('    attrsData.push(attr);');
    L.push('  });');
    L.push('  tbody.innerHTML=rowHtml;');
    L.push('  _APP.attrsData=attrsData;');
    L.push('  var revBtns=tbody.querySelectorAll(".cat-attr-revert");');
    L.push('  for(var rbi=0;rbi<revBtns.length;rbi++){');
    L.push('    (function(rbtn,attr){');
    L.push('      rbtn.addEventListener("click",function(){');
    L.push('        if(rbtn.disabled)return;');
    L.push('        var q2=String.fromCharCode(34);');
    L.push('        var idx=rbtn.getAttribute("data-idx");');
    L.push('        var cb2=tbody.querySelector(".cat-attr-cb[data-idx="+q2+idx+q2+"]");');
    L.push('        var attrId=cb2?cb2.getAttribute("data-attrid"):attr.id;');
    L.push('        if(!confirm("Delete attribute "+attrId+" from SFCC? This cannot be undone."))return;');
    L.push('        rbtn.disabled=true;rbtn.textContent="Reverting...";');
    L.push('        var ao=document.getElementById("attr-overall");');
    L.push('        _APP.post(_APP.ATTRS_URL,"delete="+encodeURIComponent(JSON.stringify([attrId])),function(ddata){');
    L.push('          if(!ddata.ok){');
    L.push('            rbtn.disabled=false;rbtn.textContent="Revert";');
    L.push('            if(ao){ao.textContent="Revert failed ("+attrId+"): "+(ddata.error||"failed");ao.style.color="#c62828";}');
    L.push('            return;');
    L.push('          }');
    L.push('          rbtn.textContent="Reverted";rbtn.style.color="#2e7d32";rbtn.style.borderColor="#a5d6a7";rbtn.style.background="#e8f5e9";');
    L.push('          var row2=tbody.querySelector("tr[data-rowidx="+q2+idx+q2+"]");');
    L.push('          if(row2)row2.style.opacity="0.5";');
    L.push('          var sp2=tbody.querySelector(".cat-status-span[data-idx="+q2+idx+q2+"]");');
    L.push('          if(sp2){sp2.textContent="Missing";sp2.style.background="#fff3e0";sp2.style.color="#e65100";}');
    L.push('          if(cb2){cb2.checked=true;cb2.setAttribute("data-attrexists","");}');
    L.push('          if(_APP.attrsData&&_APP.attrsData[idx]){_APP.attrsData[idx].exists=false;}');
    L.push('          if(ao){ao.textContent="Deleted: "+attrId;ao.style.color="#2e7d32";}');
    L.push('        });');
    L.push('      });');
    L.push('    }(revBtns[rbi],attrsData[rbi]));');
    L.push('  }');
    L.push('};');
    L.push('_APP.refreshAttrTable=function(){');
    L.push('  _APP.post(_APP.ATTRS_URL,"",function(d){');
    L.push('    if(d.ok&&d.attrs)_APP.renderAttrTable(d.attrs);');
    L.push('  });');
    L.push('};');

    L.push('function a(k,v){return " "+k+"="+String.fromCharCode(34)+v+String.fromCharCode(34);}');
    L.push('_APP.onExportChange=function(catId,val){');
    L.push('  _APP.selectedForExport[catId]=val;');
    L.push('  if(val){');
    L.push('    var pid=_APP.effectiveParentId(catId);');
    L.push('    while(pid&&pid!=="root"){');
    L.push('      _APP.selectedForExport[pid]=true;');
    L.push('      var pCb=document.querySelector(".cat-export-cb[data-catid=\'"+pid+"\']");');
    L.push('      if(pCb)pCb.checked=true;');
    L.push('      pid=_APP.effectiveParentId(pid);');
    L.push('    }');
    L.push('  }');
    L.push('};');
    L.push('_APP.selectAllExport=function(){');
    L.push('  if(!_APP.allCategories)return;');
    L.push('  var hasProdData=Object.keys(_APP.productCounts||{}).length>0;');
    L.push('  _APP.allCategories.forEach(function(c){');
    L.push('    _APP.selectedForExport[c.id]=hasProdData?((_APP.productCounts[c.name]||0)>0):true;');
    L.push('  });');
    L.push('  _APP.renderTable();');
    L.push('};');
    L.push('_APP.deselectAllExport=function(){if(!_APP.allCategories)return;_APP.allCategories.forEach(function(c){_APP.selectedForExport[c.id]=false;});_APP.renderTable();};');

    L.push('_APP.post = function(url,params,onDone){');
    L.push('  var req=new XMLHttpRequest();');
    L.push('  req.open("POST",url,true);');
    L.push('  req.setRequestHeader("Content-Type","application/x-www-form-urlencoded");');
    L.push('  req.onreadystatechange=function(){');
    L.push('    if(req.readyState!==4)return;');
    L.push('    var raw=req.responseText||"";');
    L.push('    var start=raw.indexOf("{");');
    L.push('    if(start>0)raw=raw.substring(start);');
    L.push('    var data;');
    L.push('    try{data=JSON.parse(raw);}catch(e){data={ok:false,error:"Parse error"};}');
    L.push('    onDone(data);');
    L.push('  };');
    L.push('  req.send(params);');
    L.push('};');

    L.push('_APP.openInNewTab=function(url){');
    L.push('  var a=document.createElement("a");');
    L.push('  a.href=url;a.target="_blank";');
    L.push('  document.body.appendChild(a);a.click();document.body.removeChild(a);');
    L.push('};');
    L.push('_APP.getImpexFolderUrl=function(){');
    L.push('  var base=window.location.href.split("?")[0].replace(/\\/[^\\/]+$/,"/");');
    L.push('  return base+"ViewStudioSetup-OpenFolder?TargetFolder="+encodeURIComponent("Sites/Impex/"+(_APP.IMPEX_PATH||"src/migration/catalog"));');
    L.push('};');

    L.push('_APP.toCamelCase=function(str){');
    L.push('  if(!str)return"";');
    L.push('  return str.replace(/[-_]+/g," ").replace(/([a-z])([A-Z])/g,"$1 $2").replace(/\\b\\w/g,function(c){return c.toUpperCase();});');
    L.push('};');

    L.push('_APP.catalogMode="existing";');
    L.push('_APP.newCatalogId="";');
    L.push('_APP.setCatalogMode=function(mode){');
    L.push('  _APP.catalogMode=mode;');
    L.push('  var ep=document.getElementById("cat-panel-existing");');
    L.push('  var np=document.getElementById("cat-panel-new");');
    L.push('  var et=document.getElementById("cat-tab-existing");');
    L.push('  var nt=document.getElementById("cat-tab-new");');
    L.push('  if(mode==="existing"){');
    L.push('    if(ep)ep.style.display="block";if(np)np.style.display="none";');
    L.push('    if(et){et.style.color="#0070d2";et.style.borderBottom="3px solid #0070d2";}');
    L.push('    if(nt){nt.style.color="#54698d";nt.style.borderBottom="3px solid transparent";}');
    L.push('  }else{');
    L.push('    if(ep)ep.style.display="none";if(np)np.style.display="block";');
    L.push('    if(et){et.style.color="#54698d";et.style.borderBottom="3px solid transparent";}');
    L.push('    if(nt){nt.style.color="#0070d2";nt.style.borderBottom="3px solid #0070d2";}');
    L.push('  }');
    L.push('};');
    L.push('_APP.getCatalogId=function(){');
    L.push('  if(_APP.catalogMode==="new"){return _APP.newCatalogId||document.getElementById("new-catalog-id").value.trim();}');
    L.push('  var el=document.getElementById("cat-catalog-select");');
    L.push('  return el?el.value.trim():"";');
    L.push('};');

    L.push('_APP.goToStep=function(n){');
    L.push('  [1,2,3].forEach(function(i){');
    L.push('    var p=document.getElementById("panel-step"+i);');
    L.push('    var t=document.getElementById("tab-"+i);');
    L.push('    if(p)p.style.display=(i===n)?"block":"none";');
    L.push('    if(t){t.style.color=(i===n)?"#0070d2":"#54698d";t.style.borderBottom=(i===n)?"3px solid #0070d2":"3px solid transparent";}');
    L.push('  });');
    L.push('};');

    L.push('_APP.setPhase=function(id,state,detail,pct){');
    L.push('  var li=document.getElementById("cat-phase-"+id);');
    L.push('  var st=document.getElementById("cat-status-"+id);');
    L.push('  var det=document.getElementById("cat-detail-"+id);');
    L.push('  var bar=document.getElementById("cat-bar-"+id);');
    L.push('  if(!li)return;');
    L.push('  li.className="acc-phases__item acc-phases__item--"+state;');
    L.push('  if(st)st.textContent=state;');
    L.push('  if(det)det.textContent=detail||"";');
    L.push('  if(bar)bar.style.width=(pct||0)+"%";');
    L.push('};');

    L.push('_APP.effectiveParentId=function(catId){');
    L.push('  if(_APP.pendingParent[catId]!==undefined)return _APP.pendingParent[catId];');
    L.push('  if(_APP.hierarchyOverrides[catId]!==undefined)return _APP.hierarchyOverrides[catId];');
    L.push('  var cat=_APP.catMap[catId];');
    L.push('  return cat?(cat.parentId||"root"):"root";');
    L.push('};');

    L.push('_APP.getDepth=function(catId,visited){');
    L.push('  visited=visited||{};');
    L.push('  if(visited[catId])return 0;');
    L.push('  visited[catId]=true;');
    L.push('  var pId=_APP.effectiveParentId(catId);');
    L.push('  if(!pId||pId==="root")return 0;');
    L.push('  return _APP.catMap[pId]?1+_APP.getDepth(pId,visited):0;');
    L.push('};');

    L.push('_APP.isDescendant=function(catId,targetId){');
    L.push('  if(!targetId||targetId==="root")return false;');
    L.push('  var visited={};var cur=targetId;');
    L.push('  while(cur&&cur!=="root"){');
    L.push('    if(visited[cur])break;');
    L.push('    visited[cur]=true;');
    L.push('    if(cur===catId)return true;');
    L.push('    cur=_APP.effectiveParentId(cur);');
    L.push('  }');
    L.push('  return false;');
    L.push('};');

    L.push('_APP.getPosition=function(catId){');
    L.push('  if(_APP.pendingOrder[catId]!==undefined)return _APP.pendingOrder[catId];');
    L.push('  if(_APP.orderOverrides[catId]!==undefined)return _APP.orderOverrides[catId];');
    L.push('  var cat=_APP.catMap[catId];');
    L.push('  return cat?(cat.position||0):0;');
    L.push('};');

    L.push('_APP.getLevelColor=function(depth){');
    L.push('  var colors=["#0070d2","#5b5fc7","#2e7d32","#e65100"];');
    L.push('  return colors[depth]||"#78909c";');
    L.push('};');

    L.push('_APP.buildParentOptions=function(catId){');
    L.push('  var Q=String.fromCharCode(34);');
    L.push('  var html="<option value="+Q+"root"+Q+">root (top level)</option>";');
    L.push('  _APP.allCategories.forEach(function(c){');
    L.push('    if(c.id===catId)return;');
    L.push('    if(_APP.isDescendant(catId,c.id))return;');
    L.push('    html+="<option value="+Q+c.id+Q+">"+c.id+"</option>";');
    L.push('  });');
    L.push('  return html;');
    L.push('};');

    L.push('_APP.buildSortedRows=function(){');
    L.push('  var result=[];var visited={};');
    L.push('  function visitGroup(parentId){');
    L.push('    var children=_APP.allCategories.filter(function(c){return _APP.effectiveParentId(c.id)===parentId;});');
    L.push('    children.sort(function(a,b){return _APP.getPosition(a.id)-_APP.getPosition(b.id);});');
    L.push('    children.forEach(function(cat){');
    L.push('      if(visited[cat.id])return;');
    L.push('      visited[cat.id]=true;');
    L.push('      result.push({id:cat.id,name:cat.name,parentId:_APP.effectiveParentId(cat.id),depth:_APP.getDepth(cat.id),position:_APP.getPosition(cat.id)});');
    L.push('      visitGroup(cat.id);');
    L.push('    });');
    L.push('  }');
    L.push('  visitGroup("root");');
    L.push('  _APP.allCategories.forEach(function(cat){if(!visited[cat.id])result.push({id:cat.id,name:cat.name,parentId:_APP.effectiveParentId(cat.id),depth:_APP.getDepth(cat.id),position:_APP.getPosition(cat.id)});});');
    L.push('  return result;');
    L.push('};');

    L.push('_APP.applyDrop=function(srcId,tgtId,tgtParent,dropTop){');
    L.push('  if(dropTop){');
    L.push('    if(tgtParent!=="root"&&_APP.isDescendant(srcId,tgtParent)){alert("Cannot move: circular reference.");return false;}');
    L.push('    _APP.pendingParent[srcId]=tgtParent;');
    L.push('    var siblings=_APP.allCategories.filter(function(c){return c.id!==srcId&&_APP.effectiveParentId(c.id)===tgtParent;}).sort(function(a,b){return _APP.getPosition(a.id)-_APP.getPosition(b.id);});');
    L.push('    var tgtPos=siblings.length;');
    L.push('    for(var i=0;i<siblings.length;i++){if(siblings[i].id===tgtId){tgtPos=i;break;}}');
    L.push('    siblings.splice(tgtPos,0,_APP.catMap[srcId]);');
    L.push('    siblings.forEach(function(s,idx){_APP.pendingOrder[s.id]=idx+1;});');
    L.push('  }else{');
    L.push('    if(tgtId===srcId||_APP.isDescendant(srcId,tgtId)){alert("Cannot move: circular reference.");return false;}');
    L.push('    _APP.pendingParent[srcId]=tgtId;');
    L.push('    var ec=_APP.allCategories.filter(function(c){return c.id!==srcId&&_APP.effectiveParentId(c.id)===tgtId;}).sort(function(a,b){return _APP.getPosition(a.id)-_APP.getPosition(b.id);});');
    L.push('    ec.forEach(function(c,idx){_APP.pendingOrder[c.id]=idx+1;});');
    L.push('    _APP.pendingOrder[srcId]=ec.length+1;');
    L.push('  }');
    L.push('  return true;');
    L.push('};');

    L.push('_APP.buildLevelFilterTabs=function(){');
    L.push('  var tabsEl=document.getElementById("level-filter-tabs");');
    L.push('  if(!tabsEl)return;');
    L.push('  var depths={};');
    L.push('  _APP.allCategories.forEach(function(c){var d=_APP.getDepth(c.id);depths[d]=(depths[d]||0)+1;});');
    L.push('  var levels=Object.keys(depths).map(Number).sort(function(a,b){return a-b;});');
    L.push('  var colors=["#0070d2","#5b5fc7","#2e7d32","#e65100","#78909c"];');
    L.push('  var Q=String.fromCharCode(34);');
    L.push('  var abg=_APP.activeFilter==="all"?"background:#0070d2;color:#fff;":"background:#fff;color:#0070d2;";');
    L.push('  var html="<button type="+Q+"button"+Q+" data-level="+Q+"all"+Q+" style="+Q+"padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:2px solid #0070d2;"+abg+Q+">All ("+_APP.allCategories.length+")</button>";');
    L.push('  levels.forEach(function(lvl){');
    L.push('    var color=colors[lvl]||"#78909c";');
    L.push('    var isActive=_APP.activeFilter===String(lvl);');
    L.push('    var lbg=isActive?"background:"+color+";color:#fff;":"background:#fff;color:"+color+";";');
    L.push('    html+="<button type="+Q+"button"+Q+" data-level="+Q+lvl+Q+" style="+Q+"padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:2px solid "+color+";"+lbg+Q+">L"+(lvl+1)+" ("+depths[lvl]+")</button>";');
    L.push('  });');
    L.push('  tabsEl.innerHTML=html;');
    L.push('  tabsEl.style.display="flex";');
    L.push('  var btns=tabsEl.querySelectorAll("button");');
    L.push('  for(var i=0;i<btns.length;i++){btns[i].addEventListener("click",function(){_APP.activeFilter=this.getAttribute("data-level");_APP.buildLevelFilterTabs();_APP.applyLevelFilter();});}');
    L.push('};');

    L.push('_APP.applyLevelFilter=function(){');
    L.push('  var rows=document.querySelectorAll("#main-cat-tbody tr[data-catid]");');
    L.push('  for(var i=0;i<rows.length;i++){rows[i].style.display=(_APP.activeFilter==="all"||rows[i].getAttribute("data-depth")===_APP.activeFilter)?"":"none";}');
    L.push('};');

    L.push('_APP.updatePendingSummary=function(){');
    L.push('  var allIds={};');
    L.push('  Object.keys(_APP.pendingParent).forEach(function(k){allIds[k]=true;});');
    L.push('  Object.keys(_APP.pendingOrder).forEach(function(k){allIds[k]=true;});');
    L.push('  var total=Object.keys(allIds).length;');
    L.push('  var s=document.getElementById("hierarchy-changes-summary");');
    L.push('  var b=document.getElementById("btn-save-hierarchy");');
    L.push('  var c=document.getElementById("hierarchy-changes-count");');
    L.push('  if(total>0){if(s)s.style.display="block";if(c)c.textContent=total;}');
    L.push('  else{if(s)s.style.display="none";}');
    L.push('};');

    L.push('_APP._sharedSelCatId=null;');

    L.push('_APP._applyParentPick=function(newVal){');
    L.push('  var catId=_APP._sharedSelCatId;');
    L.push('  var dd=document.getElementById("_parent-dd");if(dd)dd.style.display="none";');
    L.push('  if(!catId||!newVal)return;');
    L.push('  var origParent=_APP.catMap[catId]?(_APP.catMap[catId].parentId||"root"):"root";');
    L.push('  if(newVal===catId){alert("A category cannot be its own parent.");return;}');
    L.push('  if(newVal!=="root"&&_APP.isDescendant(catId,newVal)){alert("Cannot set: circular reference.");return;}');
    L.push('  if(newVal===origParent){delete _APP.pendingParent[catId];}else{');
    L.push('    _APP.pendingParent[catId]=newVal;');
    L.push('    var sib=_APP.allCategories.filter(function(c){return c.id!==catId&&_APP.effectiveParentId(c.id)===newVal;}).sort(function(a,b){return _APP.getPosition(a.id)-_APP.getPosition(b.id);});');
    L.push('    _APP.pendingOrder[catId]=sib.length+1;');
    L.push('  }');
    L.push('  _APP._sharedSelCatId=null;');
    L.push('  _APP.updatePendingSummary();');
    L.push('  _APP.renderTable();');
    L.push('};');

    L.push('_APP.buildSharedParentSelect=function(){');
    L.push('  var dd=document.getElementById("_parent-dd");');
    L.push('  if(dd){dd.parentNode.removeChild(dd);}');
    L.push('  dd=document.createElement("div");');
    L.push('  dd.id="_parent-dd";');
    L.push('  dd.style.cssText="position:fixed;z-index:10000;background:#fff;border:1px solid #dddbda;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.18);display:none;width:300px;overflow:hidden;font-family:inherit;";');
    L.push('  dd.addEventListener("click",function(e){e.stopPropagation();});');
    // Search input
    L.push('  var srchWrap=document.createElement("div");srchWrap.style.cssText="padding:8px 10px;border-bottom:1px solid #f0f0f0;background:#f4f6f9;";');
    L.push('  var srch=document.createElement("input");srch.type="text";srch.placeholder="Search...";srch.id="_parent-dd-search";');
    L.push('  srch.style.cssText="width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;border:1px solid #dddbda;border-radius:3px;outline:none;";');
    L.push('  srch.addEventListener("input",function(){_APP._filterParentDD(this.value);});');
    L.push('  srch.addEventListener("click",function(e){e.stopPropagation();});');
    L.push('  srchWrap.appendChild(srch);dd.appendChild(srchWrap);');
    // List container
    L.push('  var list=document.createElement("div");list.id="_parent-dd-list";list.style.cssText="max-height:240px;overflow-y:auto;";');
    L.push('  dd.appendChild(list);');
    L.push('  document.body.appendChild(dd);');
    L.push('  document.addEventListener("click",function(){var d=document.getElementById("_parent-dd");if(d)d.style.display="none";});');
    L.push('  _APP._buildParentDDItems("");');
    L.push('};');

    L.push('_APP._buildParentDDItems=function(q){');
    L.push('  var list=document.getElementById("_parent-dd-list");if(!list)return;');
    L.push('  var frag=document.createDocumentFragment();');
    L.push('  function makeItem(val,label,isCurrent){');
    L.push('    var d=document.createElement("div");');
    L.push('    d.style.cssText="padding:7px 12px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #f8f8f8;"+(isCurrent?"background:#e8f4fd;font-weight:600;color:#0070d2;":"color:#16325c;");');
    L.push('    d.onmouseover=function(){if(!isCurrent)this.style.background="#f4f6f9";};');
    L.push('    d.onmouseout=function(){if(!isCurrent)this.style.background="";};');
    L.push('    var badge=document.createElement("span");badge.textContent=val;badge.style.cssText="font-family:monospace;font-size:10px;background:#e8e8e8;padding:1px 5px;border-radius:10px;color:#54698d;flex-shrink:0;";');
    L.push('    var nm=document.createElement("span");nm.textContent=label;nm.style.cssText="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";');
    L.push('    d.appendChild(badge);d.appendChild(nm);');
    L.push('    d.addEventListener("mousedown",function(e){e.preventDefault();_APP._applyParentPick(val);});');
    L.push('    return d;');
    L.push('  }');
    L.push('  var cur=_APP._sharedSelCatId?_APP.effectiveParentId(_APP._sharedSelCatId):"";');
    L.push('  var ql=q.toLowerCase();');
    L.push('  if(!ql||"root".indexOf(ql)>-1||"top level".indexOf(ql)>-1)frag.appendChild(makeItem("root","top level",cur==="root"));');
    L.push('  var count=0;');
    L.push('  for(var i=0;i<_APP.allCategories.length;i++){');
    L.push('    var c=_APP.allCategories[i];');
    L.push('    if(c.id===_APP._sharedSelCatId)continue;');
    L.push('    if(ql&&c.id.toLowerCase().indexOf(ql)===-1&&(c.name||"").toLowerCase().indexOf(ql)===-1)continue;');
    L.push('    frag.appendChild(makeItem(c.id,c.name||c.id,cur===c.id));');
    L.push('    if(++count>=300)break;');
    L.push('  }');
    L.push('  list.innerHTML="";list.appendChild(frag);');
    L.push('};');

    L.push('_APP._filterParentDD=function(q){_APP._buildParentDDItems(q);};');

    L.push('_APP.openSharedParentSelect=function(catId,currentParent,cellEl,evt){');
    L.push('  if(evt&&evt.stopPropagation)evt.stopPropagation();');
    L.push('  _APP._sharedSelCatId=catId;');
    L.push('  var dd=document.getElementById("_parent-dd");if(!dd)return;');
    L.push('  var srch=document.getElementById("_parent-dd-search");if(srch){srch.value="";}');
    L.push('  _APP._buildParentDDItems("");');
    L.push('  var rect=cellEl.getBoundingClientRect();');
    L.push('  var top=rect.bottom+2;');
    L.push('  if(top+280>window.innerHeight)top=rect.top-282;');
    L.push('  dd.style.top=top+"px";');
    L.push('  dd.style.left=Math.min(rect.left,window.innerWidth-310)+"px";');
    L.push('  dd.style.display="block";');
    L.push('  if(srch)setTimeout(function(){srch.focus();},50);');
    L.push('};');

    L.push('_APP.renderTable=function(){');
    L.push('  var tbody=document.getElementById("main-cat-tbody");');
    L.push('  if(!tbody)return;');
    L.push('  var Q=String.fromCharCode(34);');
    L.push('  if(!_APP.allCategories.length){tbody.innerHTML="<tr><td colspan="+Q+"7"+Q+" style="+Q+"text-align:center;padding:30px;color:#54698d;"+Q+">Click Load Categories from CT to begin.</td></tr>";return;}');
    L.push('  var sorted=_APP.buildSortedRows();');
    L.push('  var positionByParent={};');
    L.push('  var displayPositions={};');
    L.push('  sorted.forEach(function(row){');
    L.push('    var parentId=row.parentId;');
    L.push('    if(!positionByParent[parentId])positionByParent[parentId]=0;');
    L.push('    positionByParent[parentId]++;');
    L.push('    displayPositions[row.id]=positionByParent[parentId];');
    L.push('  });');
    L.push('  var rows=[];');
    L.push('  sorted.forEach(function(row,idx){');
    L.push('    var catId=row.id;');
    L.push('    var isPC=_APP.pendingParent[catId]!==undefined||_APP.hierarchyOverrides[catId]!==undefined;');
    L.push('    var isOC=_APP.pendingOrder[catId]!==undefined||_APP.orderOverrides[catId]!==undefined;');
    L.push('    var isChanged=isPC||isOC;');
    L.push('    var currentParent=row.parentId||"root";');
    L.push('    var lvlColor=_APP.getLevelColor(row.depth);');
    L.push('    var lvlLabel="L"+(row.depth+1);');
    L.push('    var pb=isOC?"background:#fff3e0;border-color:#ffb300;color:#e65100;":"";');
    L.push('    var rb=isChanged?"background:#fff8e1;":"";');
    L.push('    var tdSt="padding:7px 8px;border-bottom:1px solid #f0f0f0;";');
    L.push('    var origParent=_APP.catMap[catId]?(_APP.catMap[catId].parentId||"root"):"root";');
    L.push('    var cellBg=isPC?"border:1px solid #0070d2;color:#0070d2;font-weight:600;":"border:1px solid #dddbda;color:#16325c;";');
    L.push('    var trHtml="<tr"');
    L.push('      +" data-catid="+Q+catId+Q');
    L.push('      +" data-depth="+Q+row.depth+Q');
    L.push('      +" data-parent="+Q+currentParent+Q');
    L.push('      +" data-changed="+Q+(isChanged?"1":"0")+Q');
    L.push('      +" style="+Q+rb+Q+">";');
    L.push('    trHtml+="<td"+a("style",tdSt+"text-align:center;")+"><span class="+Q+"drag-handle-icon"+Q+a("data-catid",catId)+a("style","cursor:grab;color:#a8b7c7;font-size:20px;user-select:none;")+">&#8597;</span></td>";');
    L.push('    trHtml+="<td"+a("style",tdSt)+"><span"+a("style","display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;color:#fff;background:"+lvlColor+";")+">"+lvlLabel+"</span></td>";');
    L.push('    trHtml+="<td"+a("style",tdSt)+"><span id="+Q+"pos-"+catId+Q+a("style","display:inline-block;background:#f4f6f9;border:1px solid #dddbda;border-radius:3px;padding:1px 6px;font-size:11px;font-family:monospace;"+pb)+">"+displayPositions[catId]+"</span></td>";');
    L.push('    trHtml+="<td"+a("style",tdSt+"font-family:monospace;font-size:11px;")+">"+catId+"</td>";');
    L.push('    var prodCt=(_APP.productCounts&&_APP.productCounts[row.name])||0;');
    L.push('    var hasProductData=Object.keys(_APP.productCounts||{}).length>0;');
    L.push('    var prodBadge=prodCt>0?"<span"+a("title",prodCt+" product(s) assigned in Shopify")+a("style","margin-left:6px;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;padding:1px 7px;border-radius:10px;font-size:11px;cursor:default;")+" >"+prodCt+" &#9679;</span>":"";');
    L.push('    trHtml+="<td"+a("style",tdSt+"font-weight:600;color:#16325c;")+">"+_APP.toCamelCase(row.name)+prodBadge+"</td>";');
    L.push('    trHtml+="<td"+a("style",tdSt)+"><div"+a("onclick","_APP.openSharedParentSelect(\'"+catId+"\',\'"+currentParent+"\',this,event);")+a("style","display:flex;align-items:center;justify-content:space-between;gap:6px;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:12px;"+cellBg)+"><span style="+Q+"overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;"+Q+">"+currentParent+"</span><span style="+Q+"font-size:10px;opacity:0.6;flex-shrink:0;"+Q+">&#9660;</span></div></td>";');
    L.push('    var isExport=_APP.selectedForExport[catId]!==undefined?_APP.selectedForExport[catId]:(!hasProductData||prodCt>0);');
    L.push('    trHtml+="<td"+a("style",tdSt+"text-align:center;")+"><input"+a("type","checkbox")+a("class","cat-export-cb")+a("data-catid",catId)+a("onchange","_APP.onExportChange(\'"+catId+"\',this.checked);")+a("title",prodCt>0?(prodCt+" product(s) assigned in Shopify"):"No products assigned")+(isExport?" checked":"")+" /></td>";');
    L.push('    trHtml+="</tr>";');
    L.push('    rows.push(trHtml);');
    L.push('  });');
    L.push('  tbody.innerHTML=rows.join("");');
    L.push('  _APP.initDragDrop(tbody);');
    L.push('  _APP.buildLevelFilterTabs();');
    L.push('  _APP.applyLevelFilter();');
    L.push('  _APP.updatePendingSummary();');
    L.push('};');

    L.push('_APP.onParentDropdownChange=function(evt){');
    L.push('  var select=evt.target;');
    L.push('  var catId=select.getAttribute("data-catid");');
    L.push('  var orig=select.getAttribute("data-orig");');
    L.push('  var newVal=select.value;');
    L.push('  if(newVal===catId){alert("A category cannot be its own parent.");select.value=_APP.effectiveParentId(catId);return;}');
    L.push('  if(newVal!=="root"&&_APP.isDescendant(catId,newVal)){alert("Cannot set: circular reference.");select.value=_APP.effectiveParentId(catId);return;}');
    L.push('  if(newVal===orig){delete _APP.pendingParent[catId];}else{');
    L.push('    _APP.pendingParent[catId]=newVal;');
    L.push('    var sib=_APP.allCategories.filter(function(c){return c.id!==catId&&_APP.effectiveParentId(c.id)===newVal;}).sort(function(a,b){return _APP.getPosition(a.id)-_APP.getPosition(b.id);});');
    L.push('    _APP.pendingOrder[catId]=sib.length+1;');
    L.push('  }');
    L.push('  _APP.updatePendingSummary();');
    L.push('  _APP.renderTable();');
    L.push('};');

    L.push('_APP.initDragDrop=function(tbody){');
    L.push('  var dragRow=null;var dragId=null;');
    L.push('  function getRow(el){while(el&&el.tagName!=="TR")el=el.parentNode;return(el&&el.getAttribute("data-catid"))?el:null;}');
    L.push('  function getAllRows(){return Array.prototype.slice.call(tbody.querySelectorAll("tr[data-catid]"));}');
    L.push('  function removePH(){var p=document.getElementById("drag-placeholder");if(p&&p.parentNode)p.parentNode.removeChild(p);}');
    L.push('  function makePH(h){var p=document.createElement("tr");p.id="drag-placeholder";p.style.cssText="height:"+(h||36)+"px;background:#e8f4fd;pointer-events:none;";return p;}');
    L.push('  function getRowAtY(y){');
    L.push('    var rows=getAllRows();');
    L.push('    for(var i=0;i<rows.length;i++){if(rows[i].style.display==="none")continue;var r=rows[i].getBoundingClientRect();if(y>=r.top&&y<=r.bottom)return{row:rows[i],top:y<r.top+r.height/2};}');
    L.push('    var last=null;for(var j=rows.length-1;j>=0;j--){if(rows[j].style.display!=="none"){last=rows[j];break;}}');
    L.push('    if(last){var lr=last.getBoundingClientRect();if(y>lr.bottom)return{row:last,top:false};}');
    L.push('    return null;');
    L.push('  }');
    L.push('  function onMM(e){');
    L.push('    if(!dragRow)return;e.preventDefault();');
    L.push('    var rz=document.getElementById("root-drop-zone");');
    L.push('    if(rz){var rr=rz.getBoundingClientRect();if(e.clientY>=rr.top&&e.clientY<=rr.bottom&&e.clientX>=rr.left&&e.clientX<=rr.right){rz.style.background="#cce4f7";rz.style.borderColor="#0050a0";removePH();return;}else{rz.style.background="#f0f7ff";rz.style.borderColor="#0070d2";}}');
    L.push('    var hit=getRowAtY(e.clientY);if(!hit||hit.row===dragRow)return;');
    L.push('    removePH();var ph=makePH(dragRow.getBoundingClientRect().height);');
    L.push('    if(hit.top){ph.style.borderTop="3px solid #0070d2";hit.row.parentNode.insertBefore(ph,hit.row);}');
    L.push('    else{ph.style.borderBottom="3px solid #5b5fc7";var ns=hit.row.nextSibling;if(ns)hit.row.parentNode.insertBefore(ph,ns);else hit.row.parentNode.appendChild(ph);}');
    L.push('  }');
    L.push('  function onMU(e){');
    L.push('    document.removeEventListener("mousemove",onMM);document.removeEventListener("mouseup",onMU);');
    L.push('    if(!dragRow)return;');
    L.push('    dragRow.style.opacity="";dragRow.style.background=dragRow.getAttribute("data-changed")==="1"?"#fff8e1":"";');
    L.push('    var rz=document.getElementById("root-drop-zone");');
    L.push('    if(rz){var rr=rz.getBoundingClientRect();if(e.clientY>=rr.top&&e.clientY<=rr.bottom&&e.clientX>=rr.left&&e.clientX<=rr.right){removePH();rz.style.display="none";_APP.pendingParent[dragId]="root";var rc=_APP.allCategories.filter(function(c){return c.id!==dragId&&_APP.effectiveParentId(c.id)==="root";}).sort(function(a,b){return _APP.getPosition(a.id)-_APP.getPosition(b.id);});rc.forEach(function(c,idx){_APP.pendingOrder[c.id]=idx+1;});_APP.pendingOrder[dragId]=rc.length+1;dragRow=null;dragId=null;_APP.draggingId=null;_APP.updatePendingSummary();_APP.renderTable();return;}rz.style.display="none";}');
    L.push('    var p=document.getElementById("drag-placeholder");if(!p){dragRow=null;dragId=null;_APP.draggingId=null;return;}');
    L.push('    var isTop=p.style.borderTop!=="";var tgt=null;');
    L.push('    if(isTop){var nx=p.nextSibling;while(nx&&(!nx.getAttribute||!nx.getAttribute("data-catid")))nx=nx.nextSibling;if(nx&&nx.getAttribute("data-catid"))tgt=nx;}');
    L.push('    else{var pv=p.previousSibling;while(pv&&(!pv.getAttribute||!pv.getAttribute("data-catid")))pv=pv.previousSibling;if(pv&&pv.getAttribute("data-catid"))tgt=pv;}');
    L.push('    removePH();');
    L.push('    if(!tgt||tgt===dragRow){dragRow=null;dragId=null;_APP.draggingId=null;return;}');
    L.push('    var ok=_APP.applyDrop(dragId,tgt.getAttribute("data-catid"),tgt.getAttribute("data-parent"),isTop);');
    L.push('    dragRow=null;dragId=null;_APP.draggingId=null;');
    L.push('    if(ok){_APP.updatePendingSummary();_APP.renderTable();}');
    L.push('  }');
    L.push('  var handles=tbody.querySelectorAll(".drag-handle-icon");');
    L.push('  for(var h=0;h<handles.length;h++){');
    L.push('    handles[h].addEventListener("mousedown",function(e){');
    L.push('      e.preventDefault();var row=getRow(e.target);if(!row)return;');
    L.push('      dragRow=row;dragId=row.getAttribute("data-catid");_APP.draggingId=dragId;');
    L.push('      dragRow.style.opacity="0.5";dragRow.style.background="#e8f4fd";');
    L.push('      var rz=document.getElementById("root-drop-zone");if(rz)rz.style.display="block";');
    L.push('      document.addEventListener("mousemove",onMM);document.addEventListener("mouseup",onMU);');
    L.push('    });');
    L.push('  }');
    L.push('};');

    L.push('_APP.finalize=function(success,message){');
    L.push('  _APP.running=false;');
    L.push('  var btn=document.getElementById("cat-start-btn");');
    L.push('  if(btn){btn.disabled=false;btn.textContent=success?"Migration Complete":"Migration Failed";}');
    L.push('  var box=document.getElementById("cat-move-status");');
    L.push('  if(box){box.style.display="block";box.style.padding="12px 16px";box.style.borderRadius="4px";box.style.fontSize="13px";box.style.background=success?"#e8f5e9":"#fff3e0";box.style.border=success?"1px solid #2e7d32":"1px solid #ffb300";box.style.color=success?"#2e7d32":"#e65100";box.textContent=message;}');
    L.push('};');


    L.push('_APP.populateParentDropdown=function(){');
    L.push('  var sel=document.getElementById("ct-new-cat-parent");');
    L.push('  if(!sel)return;');
    L.push('  var cur=sel.value;');
    L.push('  sel.innerHTML="<option value=\\"\\">-- Root (no parent) --</option>";');
    L.push('  var cats=_APP.allCategories||[];');
    L.push('  for(var i=0;i<cats.length;i++){');
    L.push('    var opt=document.createElement("option");');
    L.push('    opt.value=cats[i].id;');
    L.push('    opt.textContent=cats[i].name+" ("+cats[i].id+")";');
    L.push('    sel.appendChild(opt);');
    L.push('  }');
    L.push('  sel.value=cur;');
    L.push('};');


    // ── _APP.init ─────────────────────────────────────────────────────────────
    L.push('_APP.init=function(){');
    L.push('  var el;');

    // Load Catalogs
    L.push('  el=document.getElementById("btn-load-catalogs");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var btn=this;var status=document.getElementById("catalog-load-status");var sel=document.getElementById("cat-catalog-select");');
    L.push('    btn.disabled=true;btn.textContent="Loading...";');
    L.push('    if(status){status.textContent="Fetching catalogs...";status.style.color="#54698d";}');
    L.push('    _APP.post(_APP.FETCH_CATALOGS_URL,"",function(data){');
    L.push('      btn.disabled=false;btn.textContent="Load Catalogs";');
    L.push('      if(!data.ok){if(status){status.textContent="Error: "+(data.error||"failed");status.style.color="#c62828";}return;}');
    L.push('      var Q=String.fromCharCode(34);');
    L.push('      if(sel){sel.innerHTML="<option value="+Q+Q+">-- Select a catalog --</option>";(data.catalogs||[]).forEach(function(c){sel.innerHTML+="<option value="+Q+c.id+Q+">"+(c.name||c.id)+" ("+c.id+")</option>";});}');
    L.push('      if(status){status.textContent=(data.total||(data.catalogs||[]).length)+" catalogs loaded";status.style.color="#2e7d32";}');
    L.push('    });');
    L.push('  });');


    // Step 1 - Check Attributes
    L.push('  el=document.getElementById("btn-check-attrs");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var btn=this;var ao=document.getElementById("attr-overall");');
    L.push('    btn.disabled=true;btn.textContent="Checking...";');
    L.push('    _APP.post(_APP.ATTRS_URL,"",function(data){');
    L.push('      btn.disabled=false;btn.textContent="Check Attributes";');
    L.push('      if(!data||!data.ok){if(ao){ao.textContent="Error: "+(data&&data.error?"Error checking: "+data.error:"Check failed — see BM logs");ao.style.color="#c62828";}return;}');
    L.push('      var attrs=data.attrs||[];');
    L.push('      _APP.renderAttrTable(attrs);');
    L.push('      var ar=document.getElementById("attr-result");if(ar)ar.style.display="block";');
    L.push('      var missing=attrs.filter(function(a){return !a.exists;});');
    L.push('      var cb=document.getElementById("btn-create-selected-attrs");');
    L.push('      if(missing.length){');
    L.push('        if(ao){ao.textContent=missing.length+" attribute(s) missing in SFCC.";ao.style.color="#e65100";}');
    L.push('      } else {');
    L.push('        if(ao){ao.textContent="All "+attrs.length+" attribute(s) already exist in SFCC.";ao.style.color="#2e7d32";}');
    L.push('      }');
    L.push('    });');
    L.push('  });');

    // Create Attributes — creates all missing attrs
    L.push('  el=document.getElementById("btn-create-selected-attrs");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var Q=String.fromCharCode(34);');
    L.push('    var btn=this;var ao=document.getElementById("attr-overall");');
    L.push('    var boxes=document.querySelectorAll("#attr-tbody .cat-attr-cb:checked");');
    L.push('    if(!boxes.length){if(ao){ao.textContent="No attributes selected — check at least one to create.";ao.style.color="#e65100";}return;}');
    L.push('    var selected=[];');
    L.push('    for(var i=0;i<boxes.length;i++){');
    L.push('      var bidx=boxes[i].getAttribute("data-idx");');
    L.push('      var origId=boxes[i].getAttribute("data-attrid");');
    L.push('      var attrExists=boxes[i].getAttribute("data-attrexists")==="1";');
    L.push('      var idInp=document.querySelector(".cm-attr-id-input[data-idx="+Q+bidx+Q+"]");');
    L.push('      var editedId=idInp&&idInp.value.trim()?idInp.value.trim():origId;');
    L.push('      var sfccT=window.AccAttrPreflight?window.AccAttrPreflight.readSfccType(bidx,boxes[i].getAttribute("data-attrtype")):boxes[i].getAttribute("data-attrtype");');
    L.push('      if(attrExists&&editedId===origId){');
    L.push('        var skipSp=document.querySelector(".cat-status-span[data-idx="+Q+bidx+Q+"]");');
    L.push('        if(skipSp){skipSp.textContent="Skipped";skipSp.style.background="#e3f2fd";skipSp.style.color="#1565c0";}');
    L.push('        boxes[i].checked=false;continue;');
    L.push('      }');
    L.push('      var canonicalId=idInp?idInp.getAttribute("data-canonical")||origId:origId;');
    L.push('      selected.push({id:editedId,canonicalId:canonicalId,originalId:(attrExists&&editedId!==origId)?origId:null,sfccType:sfccT,label:boxes[i].getAttribute("data-attrlabel"),idx:bidx});');
    L.push('    }');
    L.push('    if(!selected.length){if(ao){ao.textContent="All selected attributes already exist — skipped.";ao.style.color="#1565c0";}return;}');
    L.push('    btn.disabled=true;btn.textContent="Creating...";');
    L.push('    if(ao){ao.textContent="Creating "+selected.length+" attribute(s)...";ao.style.color="#54698d";}');
    L.push('    _APP.post(_APP.CREATE_ATTRS_URL,"attrs="+encodeURIComponent(JSON.stringify(selected)),function(data){');
    L.push('      btn.disabled=false;btn.textContent="Create Attributes";');
    L.push('      if(!data.ok){if(ao){ao.textContent="Error: "+(data.error||"failed");ao.style.color="#c62828";}return;}');
    L.push('      var res=data.result||{};');
    L.push('      if(ao){ao.textContent="Done — "+(res.created||0)+" created, "+(res.failed||0)+" failed.";ao.style.color=(res.failed||0)>0?"#e65100":"#2e7d32";}');
    L.push('      if(res.errors&&res.errors.length){var eb=document.getElementById("attr-errors");if(eb){eb.style.display="block";eb.textContent="Errors: "+res.errors.join(", ");}}');
    L.push('      var Q2=String.fromCharCode(34);');
    L.push('      for(var si=0;si<selected.length;si++){');
    L.push('        var sidx=selected[si].idx;');
    L.push('        var scb=document.querySelector(".cat-attr-cb[data-idx="+Q2+sidx+Q2+"]");');
    L.push('        var ssp=document.querySelector(".cat-status-span[data-idx="+Q2+sidx+Q2+"]");');
    L.push('        var sinp=document.querySelector(".cm-attr-id-input[data-idx="+Q2+sidx+Q2+"]");');
    L.push('        var rBtn=document.querySelector(".cat-attr-revert[data-idx="+Q2+sidx+Q2+"]");');
    L.push('        if(ssp){ssp.textContent="Exists";ssp.style.background="#e8f5e9";ssp.style.color="#2e7d32";}');
    L.push('        if(scb){scb.checked=false;scb.setAttribute("data-attrexists","1");scb.setAttribute("data-attrid",selected[si].id);}');
    L.push('        if(sinp){sinp.setAttribute("data-orig",selected[si].id);sinp.value=selected[si].id;}');
    L.push('        if(_APP.attrsData&&_APP.attrsData[sidx]){_APP.attrsData[sidx].exists=true;_APP.attrsData[sidx].id=selected[si].id;}');
    L.push('        if(rBtn){rBtn.disabled=false;rBtn.title="";}');
    L.push('      }');
    L.push('      if((res.failed||0)===0){setTimeout(function(){_APP.goToStep(2);},2000);}');
    L.push('    });');
    L.push('  });');


    // Select All
    L.push('  el=document.getElementById("btn-select-all-attrs");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var boxes=document.querySelectorAll("#attr-tbody .cat-attr-cb");');
    L.push('    for(var i=0;i<boxes.length;i++)boxes[i].checked=true;');
    L.push('  });');

    // Deselect All
    L.push('  el=document.getElementById("btn-deselect-all-attrs");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var boxes=document.querySelectorAll("#attr-tbody .cat-attr-cb");');
    L.push('    for(var i=0;i<boxes.length;i++)boxes[i].checked=false;');
    L.push('  });');

    L.push('  el=document.getElementById("btn-skip-attrs");if(el)el.addEventListener("click",function(){_APP.goToStep(2);});');

    // Step 2
    L.push('  el=document.getElementById("btn-save-hierarchy");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    Object.keys(_APP.pendingParent).forEach(function(k){_APP.hierarchyOverrides[k]=_APP.pendingParent[k];});');
    L.push('    Object.keys(_APP.pendingOrder).forEach(function(k){_APP.orderOverrides[k]=_APP.pendingOrder[k];});');
    L.push('    _APP.pendingParent={};_APP.pendingOrder={};');
    L.push('    _APP.renderTable();');
    L.push('    var total=Object.keys(_APP.hierarchyOverrides).length+Object.keys(_APP.orderOverrides).length;');
    L.push('    var applied=document.getElementById("hierarchy-applied-summary");var appCnt=document.getElementById("hierarchy-applied-count");');
    L.push('    if(appCnt)appCnt.textContent=total;');
    L.push('    if(applied)applied.style.display="block";');
    L.push('    document.getElementById("hierarchy-changes-summary").style.display="none";');
    L.push('  });');

    L.push('  el=document.getElementById("btn-select-all-export");if(el)el.addEventListener("click",function(){_APP.selectAllExport();});');
    L.push('  el=document.getElementById("btn-select-all-export-all");if(el)el.addEventListener("click",function(){if(!_APP.allCategories)return;_APP.allCategories.forEach(function(c){_APP.selectedForExport[c.id]=true;});_APP.renderTable();});');
    L.push('  el=document.getElementById("btn-deselect-all-export");if(el)el.addEventListener("click",function(){_APP.deselectAllExport();});');

    L.push('  el=document.getElementById("btn-reset-hierarchy");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    _APP.hierarchyOverrides={};_APP.orderOverrides={};_APP.pendingParent={};_APP.pendingOrder={};_APP.activeFilter="all";');
    L.push('    var applied=document.getElementById("hierarchy-applied-summary");');
    L.push('    var summary=document.getElementById("hierarchy-changes-summary");');
    L.push('    var saveBtn=document.getElementById("btn-save-hierarchy");');
    L.push('    if(applied)applied.style.display="none";');
    L.push('    if(summary)summary.style.display="none";');
    L.push('    _APP.renderTable();');
    L.push('  });');

    L.push('  el=document.getElementById("hierarchy-search");');
    L.push('  if(el)el.addEventListener("input",function(){');
    L.push('    var query=this.value.toLowerCase();');
    L.push('    var rows=document.querySelectorAll("#main-cat-tbody tr[data-catid]");');
    L.push('    for(var i=0;i<rows.length;i++){var ms=!query||rows[i].textContent.toLowerCase().indexOf(query)>-1;var ml=_APP.activeFilter==="all"||rows[i].getAttribute("data-depth")===_APP.activeFilter;rows[i].style.display=(ms&&ml)?"":"none";}');
    L.push('  });');
    L.push('  window._APP=_APP;');

    // CT load handler — unchanged
    L.push('  el=document.getElementById("btn-load-categories");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var btn=this;var status=document.getElementById("hierarchy-fetch-status");');
    L.push('    var locale=document.getElementById("cat-locale")?document.getElementById("cat-locale").value.trim():"en-US";');
    L.push('    btn.disabled=true;btn.textContent="Loading...";');
    L.push('    _APP.allCategories=[];_APP.catMap={};');
    L.push('    _APP.hierarchyOverrides={};_APP.orderOverrides={};_APP.pendingParent={};_APP.pendingOrder={};_APP.activeFilter="all";_APP.newCatCount=0;_APP.addedCats=[];');
    L.push('    function fetchPage(offset){');
    L.push('      if(status){status.textContent="Loading... "+_APP.allCategories.length+" fetched";status.style.color="#54698d";}');
    L.push('      _APP.post(_APP.FETCH_URL,"locale="+encodeURIComponent(locale||"en-US")+"&offset="+offset,function(data){');
    L.push('        var _lbl=_APP.PLATFORM==="sap"?"SAP":_APP.PLATFORM==="shopify"?"Shopify":_APP.PLATFORM==="bigcommerce"?"BigCommerce":"CT";');
    L.push('        if(!data.ok){btn.disabled=false;btn.textContent="Load Categories from "+_lbl;if(status){status.textContent="Error: "+(data.error||"failed");status.style.color="#c62828";}return;}');
    L.push('        data.categories.forEach(function(c){_APP.allCategories.push(c);_APP.catMap[c.id]=c;});');
    L.push('        if(data.done){');
    L.push('          btn.disabled=false;btn.textContent="Load Categories from "+_lbl;');
    L.push('          if(status){status.textContent=_APP.allCategories.length+" categories loaded";status.style.color="#2e7d32";}');
    L.push('          _APP.buildSharedParentSelect();');
    L.push('          _APP.populateParentDropdown();');
    L.push('          var applied=document.getElementById("hierarchy-applied-summary");if(applied)applied.style.display="none";');
    L.push('          _APP.renderTable();');
    L.push('        } else {');
    L.push('          fetchPage(offset+data.limit);');
    L.push('        }');
    L.push('      });');
    L.push('    }');
    L.push('    fetchPage(0);');
    L.push('  });');
    // Shopify override — only replaces the handler when platform is shopify
    L.push('  if(_APP.PLATFORM==="shopify"){');
    L.push('    el=document.getElementById("btn-load-categories");');
    L.push('    if(el){');
    L.push('      el.textContent="Load Categories from Shopify";');
    L.push('      var _clone=el.cloneNode(true);el.parentNode.replaceChild(_clone,el);el=_clone;');
    L.push('      el.addEventListener("click",function(){');
    L.push('        var btn=this;var status=document.getElementById("hierarchy-fetch-status");');
    L.push('        btn.disabled=true;btn.textContent="Loading...";');
    L.push('        _APP.allCategories=[];_APP.catMap={};');
    L.push('        _APP.hierarchyOverrides={};_APP.orderOverrides={};_APP.pendingParent={};_APP.pendingOrder={};_APP.activeFilter="all";_APP.newCatCount=0;_APP.addedCats=[];');
    L.push('        function fetchShopifyPage(cursor){');
    L.push('          if(status){status.textContent="Loading categories... "+_APP.allCategories.length+" so far";status.style.color="#54698d";}');
    L.push('          _APP.post(_APP.FETCH_URL,"offset="+encodeURIComponent(cursor),function(data){');
    L.push('            if(!data.ok){btn.disabled=false;btn.textContent="Load Categories from Shopify";if(status){status.textContent="Error: "+(data.error||"failed");status.style.color="#c62828";}return;}');
    L.push('            data.categories.forEach(function(c){_APP.allCategories.push(c);_APP.catMap[c.id]=c;});');
    L.push('            _APP.renderTable();');
    L.push('            if(data.done){');
    L.push('              btn.disabled=false;btn.textContent="Load Categories from Shopify";');
    L.push('              if(status){status.textContent=_APP.allCategories.length+" categories loaded";status.style.color="#2e7d32";}');
    L.push('              _APP.buildSharedParentSelect();');
    L.push('              _APP.populateParentDropdown();');
    L.push('              var applied=document.getElementById("hierarchy-applied-summary");if(applied)applied.style.display="none";');
    L.push('              if(_APP.CHECK_PRODUCTS_URL){');
    L.push('                if(status){status.textContent="Checking product assignments...";status.style.color="#1565c0";}');
    L.push('                _APP.post(_APP.CHECK_PRODUCTS_URL,"",function(pdata){');
    L.push('                  if(pdata&&pdata.ok&&pdata.counts){_APP.productCounts=pdata.counts;}');
    L.push('                  if(status){status.textContent=_APP.allCategories.length+" categories loaded";status.style.color="#2e7d32";}');
    L.push('                  _APP.renderTable();');
    L.push('                });');
    L.push('              }');
    L.push('            } else {');
    L.push('              if(!data.nextOffset){btn.disabled=false;btn.textContent="Load Categories from Shopify";if(status){status.textContent="Error: server returned no next cursor";status.style.color="#c62828";}return;}');
    L.push('              setTimeout(function(){fetchShopifyPage(data.nextOffset);},0);');
    L.push('            }');
    L.push('          });');
    L.push('        }');
    L.push('        fetchShopifyPage(0);');
    L.push('      });');
    L.push('    }');
    L.push('  }');
    // BigCommerce override — cursor-style paging via nextOffset (same contract as Shopify)
    L.push('  if(_APP.PLATFORM==="bigcommerce"){');
    L.push('    el=document.getElementById("btn-load-categories");');
    L.push('    if(el){');
    L.push('      el.textContent="Load Categories from BigCommerce";');
    L.push('      var _bcClone=el.cloneNode(true);el.parentNode.replaceChild(_bcClone,el);el=_bcClone;');
    L.push('      el.addEventListener("click",function(){');
    L.push('        var btn=this;var status=document.getElementById("hierarchy-fetch-status");');
    L.push('        btn.disabled=true;btn.textContent="Loading...";');
    L.push('        _APP.allCategories=[];_APP.catMap={};');
    L.push('        _APP.hierarchyOverrides={};_APP.orderOverrides={};_APP.pendingParent={};_APP.pendingOrder={};_APP.activeFilter="all";_APP.newCatCount=0;_APP.addedCats=[];');
    L.push('        function fetchBCPage(cursor){');
    L.push('          if(status){status.textContent="Loading categories... "+_APP.allCategories.length+" so far";status.style.color="#54698d";}');
    L.push('          _APP.post(_APP.FETCH_URL,"offset="+encodeURIComponent(cursor),function(data){');
    L.push('            if(!data.ok){btn.disabled=false;btn.textContent="Load Categories from BigCommerce";if(status){status.textContent="Error: "+(data.error||"failed");status.style.color="#c62828";}return;}');
    L.push('            data.categories.forEach(function(c){_APP.allCategories.push(c);_APP.catMap[c.id]=c;});');
    L.push('            _APP.renderTable();');
    L.push('            if(data.done){');
    L.push('              btn.disabled=false;btn.textContent="Load Categories from BigCommerce";');
    L.push('              if(status){status.textContent=_APP.allCategories.length+" categories loaded";status.style.color="#2e7d32";}');
    L.push('              _APP.buildSharedParentSelect();');
    L.push('              _APP.populateParentDropdown();');
    L.push('              var applied=document.getElementById("hierarchy-applied-summary");if(applied)applied.style.display="none";');
    L.push('            } else {');
    L.push('              if(!data.nextOffset&&data.nextOffset!==0){btn.disabled=false;btn.textContent="Load Categories from BigCommerce";if(status){status.textContent="Error: server returned no next cursor";status.style.color="#c62828";}return;}');
    L.push('              setTimeout(function(){fetchBCPage(data.nextOffset);},0);');
    L.push('            }');
    L.push('          });');
    L.push('        }');
    L.push('        fetchBCPage(0);');
    L.push('      });');
    L.push('    }');
    L.push('  }');
    // SAP override — clone button to remove CT handler, install SAP-labelled offset handler
    L.push('  if(_APP.PLATFORM==="sap"){');
    L.push('    el=document.getElementById("btn-load-categories");');
    L.push('    if(el){');
    L.push('      el.textContent="Load Categories from SAP";');
    L.push('      var _sapClone=el.cloneNode(true);el.parentNode.replaceChild(_sapClone,el);el=_sapClone;');
    L.push('      el.addEventListener("click",function(){');
    L.push('        var btn=this;var status=document.getElementById("hierarchy-fetch-status");');
    L.push('        btn.disabled=true;btn.textContent="Loading...";');
    L.push('        _APP.allCategories=[];_APP.catMap={};');
    L.push('        _APP.hierarchyOverrides={};_APP.orderOverrides={};_APP.pendingParent={};_APP.pendingOrder={};_APP.activeFilter="all";_APP.newCatCount=0;_APP.addedCats=[];');
    L.push('        function fetchSAPPage(offset){');
    L.push('          if(status){status.textContent="Loading... "+_APP.allCategories.length+" fetched";status.style.color="#54698d";}');
    L.push('          _APP.post(_APP.FETCH_URL,"offset="+offset,function(data){');
    L.push('            if(!data.ok){btn.disabled=false;btn.textContent="Load Categories from SAP";if(status){status.textContent="Error: "+(data.error||"failed");status.style.color="#c62828";}return;}');
    L.push('            data.categories.forEach(function(c){_APP.allCategories.push(c);_APP.catMap[c.id]=c;});');
    L.push('            if(data.done){');
    L.push('              btn.disabled=false;btn.textContent="Load Categories from SAP";');
    L.push('              if(status){status.textContent=_APP.allCategories.length+" categories loaded";status.style.color="#2e7d32";}');
    L.push('              _APP.buildSharedParentSelect();');
    L.push('              _APP.populateParentDropdown();');
    L.push('              var applied=document.getElementById("hierarchy-applied-summary");if(applied)applied.style.display="none";');
    L.push('              _APP.renderTable();');
    L.push('            } else {');
    L.push('              fetchSAPPage(offset+(data.limit||200));');
    L.push('            }');
    L.push('          });');
    L.push('        }');
    L.push('        fetchSAPPage(0);');
    L.push('      });');
    L.push('    }');
    L.push('  }');

    L.push('  el=document.getElementById("btn-create-ct-category");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var key=document.getElementById("ct-new-cat-key").value.trim();');
    L.push('    var name=document.getElementById("ct-new-cat-name").value.trim();');
    L.push('    var parentId=document.getElementById("ct-new-cat-parent").value.trim();');
    L.push('    var status=document.getElementById("ct-new-cat-status");');
    L.push('    if(!key||!name){if(status){status.textContent="Key and Name are required.";status.style.color="#c62828";}return;}');
    L.push('    if(_APP.catMap&&_APP.catMap[key]){if(status){status.textContent="A category with this key already exists.";status.style.color="#c62828";}return;}');
    L.push('    if(!_APP.allCategories)_APP.allCategories=[];');
    L.push('    if(!_APP.catMap)_APP.catMap={};');
    L.push('    var newCat={id:key,name:name,parentId:parentId||""};');
    L.push('    _APP.allCategories.push(newCat);');
    L.push('    _APP.catMap[key]=newCat;');
    L.push('    _APP.addedCats.push(newCat);');
    L.push('    _APP.newCatCount++;');
    L.push('    _APP.buildSharedParentSelect();');
    L.push('    _APP.renderTable();');
    L.push('    _APP.populateParentDropdown();');
    L.push('    if(status){status.textContent="Added: "+key;status.style.color="#2e7d32";}');
    L.push('    document.getElementById("ct-new-cat-key").value="";');
    L.push('    document.getElementById("ct-new-cat-name").value="";');
    L.push('    document.getElementById("ct-new-cat-parent").value="";');
    L.push('  });');

    L.push('  el=document.getElementById("btn-back-to-step1");if(el)el.addEventListener("click",function(){_APP.goToStep(1);});');
    L.push('  el=document.getElementById("btn-back-to-step2");if(el)el.addEventListener("click",function(){_APP.goToStep(2);});');

    L.push('  el=document.getElementById("btn-next-to-step3");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var pc=Object.keys(_APP.pendingParent).length+Object.keys(_APP.pendingOrder).length;');
    L.push('    if(pc>0&&!confirm(pc+" unsaved change(s) will be discarded. Proceed?"))return;');
    L.push('    _APP.pendingParent={};_APP.pendingOrder={};');
    L.push('    var s=document.getElementById("step3-summary");');
    L.push('    var newCatPart=_APP.newCatCount>0?" | New categories: "+_APP.newCatCount:"";');
    L.push('    if(s)s.textContent="Step 3 of 3 - Export. Categories: "+_APP.allCategories.length+" | Parent changes: "+Object.keys(_APP.hierarchyOverrides).length+" | Order changes: "+Object.keys(_APP.orderOverrides).length+newCatPart+" | Catalog: "+(_APP.getCatalogId()||"not set");');
    L.push('    _APP.goToStep(3);');
    L.push('  });');

    // Step 3
    L.push('  el=document.getElementById("btn-open-impex");if(el)el.addEventListener("click",function(e){e.preventDefault();_APP.openInNewTab(_APP.getImpexFolderUrl());});');
    L.push('  el=document.getElementById("btn-open-import");if(el)el.addEventListener("click",function(e){e.preventDefault();_APP.openInNewTab(_APP.IMPORT_URL);});');

    L.push('  el=document.getElementById("cat-start-btn");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    if(_APP.running)return;');
    L.push('    var catalogId=_APP.getCatalogId();');
    L.push('    var locale=document.getElementById("cat-locale")?document.getElementById("cat-locale").value.trim():"en-US";');
    L.push('    if(!catalogId){alert("Please select or enter a Target Catalog ID.");return;}');
    L.push('    if(!locale){alert("Please enter a Default Locale.");return;}');
    L.push('    _APP.running=true;this.disabled=true;this.textContent="Running...";');
    L.push('    var cs=document.getElementById("cat-move-status");if(cs)cs.style.display="none";');
    L.push('    var pl=document.getElementById("cat-phase-list");if(pl)pl.style.display="block";');
    L.push('    var xc=document.getElementById("cat-xml-controls");if(xc)xc.style.display="none";');
    L.push('    _APP.setPhase("fetch","active","Fetching and transforming categories...",10);');
    L.push('    _APP.setPhase("import","pending","Waiting for Phase 1...",0);');
    L.push('    var fo={};');
    L.push('    Object.keys(_APP.hierarchyOverrides).forEach(function(k){fo[k]={parent:_APP.hierarchyOverrides[k]};});');
    L.push('    Object.keys(_APP.orderOverrides).forEach(function(k){if(!fo[k])fo[k]={};fo[k].position=_APP.orderOverrides[k];});');
    L.push('    var extra=(_APP.addedCats&&_APP.addedCats.length)?encodeURIComponent(JSON.stringify(_APP.addedCats)):"";');
    L.push('    var selIds=[];');
    L.push('    var exportCbs=document.querySelectorAll("#main-cat-tbody .cat-export-cb");');
    L.push('    for(var cbi=0;cbi<exportCbs.length;cbi++){if(exportCbs[cbi].checked)selIds.push(exportCbs[cbi].getAttribute("data-catid"));}');
    L.push('    if(selIds.length===0){alert("Please select at least one category to export using the Export checkboxes in Step 2.");_APP.running=false;this.disabled=false;this.textContent="Run Migration";return;}');
    L.push('    var selSet={};for(var si=0;si<selIds.length;si++){selSet[selIds[si]]=true;}');
    L.push('    var missingParents=[];');
    L.push('    for(var mi=0;mi<selIds.length;mi++){');
    L.push('      var mpId=_APP.effectiveParentId(selIds[mi]);');
    L.push('      if(mpId&&mpId!=="root"&&!selSet[mpId]){');
    L.push('        var mpCat=_APP.catMap[mpId];');
    L.push('        var mpName=mpCat?mpCat.name:mpId;');
    L.push('        if(missingParents.indexOf(mpName)===-1)missingParents.push(mpName);');
    L.push('      }');
    L.push('    }');
    L.push('    if(missingParents.length>0){');
    L.push('      var mpMsg="The following parent categories are not selected for export:\\n\\n"+missingParents.join("\\n")+"\\n\\nPlease select the parent categories too before exporting.";');
    L.push('      alert(mpMsg);_APP.running=false;this.disabled=false;this.textContent="Run Migration";return;');
    L.push('    }');
    L.push('    var selIdsParam=encodeURIComponent(JSON.stringify(selIds));');
    L.push('    var catsParam=((_APP.PLATFORM==="shopify"||_APP.PLATFORM==="bigcommerce")&&_APP.allCategories&&_APP.allCategories.length)?encodeURIComponent(JSON.stringify(_APP.allCategories)):"";');
    L.push('    var attrIdMap={};');
    L.push('    var aInps=document.querySelectorAll("#attr-tbody .cm-attr-id-input");');
    L.push('    for(var ai=0;ai<aInps.length;ai++){');
    L.push('      var canonicalId=aInps[ai].getAttribute("data-canonical");');
    L.push('      var editedId=aInps[ai].value.trim()||canonicalId;');
    L.push('      if(canonicalId&&editedId&&canonicalId!==editedId){attrIdMap[canonicalId]=editedId;}');
    L.push('    }');
    L.push('    var attrIdsParam=encodeURIComponent(JSON.stringify(attrIdMap));');
    L.push('    _APP.post(_APP.MIGRATE_URL,"catalogId="+encodeURIComponent(catalogId)+"&locale="+encodeURIComponent(locale)+"&mode=xml&platform="+encodeURIComponent(_APP.PLATFORM||"commercetools")+"&overrides="+encodeURIComponent(JSON.stringify(fo))+"&extraCategories="+extra+"&selectedIds="+selIdsParam+"&attrIds="+attrIdsParam+(catsParam?"&categoriesData="+catsParam:""),function(data){');
    L.push('      if(!data.ok){_APP.setPhase("fetch","error",data.error||"Failed",0);_APP.finalize(false,data.error||"Migration failed.");return;}');
    L.push('      _APP.setPhase("fetch","done",data.total+" categories fetched and transformed",100);');
    L.push('      _APP.setPhase("import","active","Writing XML to IMPEX...",50);');
    L.push('      var xp=document.getElementById("cat-xml-path");if(xp)xp.textContent=data.xmlPath||"";');
    L.push('      if(xc)xc.style.display="block";');
    L.push('      _APP.setPhase("import","done","XML written - click buttons below to open IMPEX",100);');
    L.push('      _APP.finalize(true,data.total+" categories exported to IMPEX XML. Use the buttons above to complete the import in BM.");');
    L.push('    });');
    L.push('  });');

    // Generate catalog XML via IMPEX
    L.push('  el=document.getElementById("btn-create-catalog");');
    L.push('  if(el)el.addEventListener("click",function(){');
    L.push('    var btn=this;');
    L.push('    var catId=document.getElementById("new-catalog-id").value.trim();');
    L.push('    var catName=document.getElementById("new-catalog-name").value.trim();');
    L.push('    var idErr=document.getElementById("new-catalog-id-error");');
    L.push('    var nameErr=document.getElementById("new-catalog-name-error");');
    L.push('    var status=document.getElementById("new-catalog-status");');
    L.push('    var result=document.getElementById("new-catalog-result");');
    L.push('    if(idErr)idErr.style.display="none";');
    L.push('    if(nameErr)nameErr.style.display="none";');
    L.push('    if(result)result.style.display="none";');
    L.push('    if(!catId){if(idErr)idErr.style.display="block";return;}');
    L.push('    if(!catName){if(nameErr)nameErr.style.display="block";return;}');
    L.push('    btn.disabled=true;btn.textContent="Generating...";');
    L.push('    if(status){status.textContent="Writing catalog XML...";status.style.color="#54698d";}');
    L.push('    _APP.post(_APP.CREATE_CATALOG_URL,"catalogId="+encodeURIComponent(catId)+"&catalogName="+encodeURIComponent(catName),function(data){');
    L.push('      btn.disabled=false;btn.textContent="Generate XML (IMPEX)";');
    L.push('      if(!data.ok){if(status){status.textContent="Error: "+(data.error||"failed");status.style.color="#c62828";}return;}');
    L.push('      if(status){status.textContent="Done";status.style.color="#2e7d32";}');
    L.push('      _APP.newCatalogId=catId;');
    L.push('      var xp=document.getElementById("new-catalog-xml-path");if(xp)xp.textContent=data.xmlPath||"";');
    L.push('      var lbl=document.getElementById("new-catalog-active-label");if(lbl)lbl.textContent="Catalog ID \\""+catId+"\\" will be used for category export.";');
    L.push('      if(result)result.style.display="block";');
    L.push('    });');
    L.push('  });');

    L.push('  el=document.getElementById("btn-new-catalog-impex");if(el)el.addEventListener("click",function(e){e.preventDefault();_APP.openInNewTab(_APP.getImpexFolderUrl());});');
    L.push('  el=document.getElementById("btn-open-bm-catalog");if(el)el.addEventListener("click",function(e){e.preventDefault();window.open("https://"+window.location.host+"/on/demandware.store/Sites-Site/default/ViewCatalogList_52-List");});');

    // Tab navigation
    L.push('  [1,2,3].forEach(function(i){var tab=document.getElementById("tab-"+i);if(tab)tab.addEventListener("click",function(){_APP.goToStep(i);});});');

    // Pre-check on load
    L.push('  _APP.post(_APP.STATUS_URL,"",function(data){');
    L.push('    if(!data.ok)return;');
    L.push('    var status=data.status||{};');
    L.push('    var missing=Object.keys(status).filter(function(k){return status[k]==="missing";});');
    L.push('    var infoBox=document.getElementById("step1-info-box");');
    L.push('    var skipBtn=document.getElementById("btn-skip-attrs");');
    L.push('    if(!missing.length){');
    L.push('      var attrNames=Object.keys(status).join(", ");if(infoBox)infoBox.textContent="Step 1 - All required custom attributes ("+attrNames+") already exist. You may skip to Step 2.";');
    L.push('      if(skipBtn){skipBtn.textContent="All exist - Skip to Step 2";skipBtn.style.background="#e8f5e9";skipBtn.style.color="#2e7d32";}');
    L.push('    }else{');
    L.push('      if(infoBox)infoBox.textContent="Step 1 - Missing: "+missing.join(", ")+". Click Check Attributes to review and create.";');
    L.push('    }');
    L.push('  });');

    L.push('};');

    return L.join('\n');
}



exports.CategoryMigration = function () {
    var cfg          = require('*/cartridge/scripts/migration/configAccessor');
    var catalogId    = (cfg.sfcc && cfg.sfcc.catalogId) ? cfg.sfcc.catalogId : 'storefront-catalog-m-en';
    var Logger     = require('dw/system/Logger');
    var instanceHost = request.httpHost;

    // Build URLs safely - no special characters
    var platformId = getParam('platform') || String(session.custom.migrationPlatformId || 'commercetools');
    session.custom.migrationPlatformId = platformId;
    var pageCtx    = migrationPageContext(platformId, 'catalog');
    var impexFolderUrl = pageCtx.impexUrl;
    var importPageUrl  = 'https://' + instanceHost + '/on/demandware.store/Sites-Site/default%3bapp%3d__bm_merchant/ViewCatalogImpex_52-Status?SelectedMenuItem=prod-cat_impex&CurrentMenuItemId=prod-cat';
    var checkAttrsUrl  = URLUtils.url('Accelerator-CheckCategoryAttributes').toString() || '';
    var checkStatusUrl = URLUtils.url('Accelerator-CheckAttributeStatus').toString()    || '';
    var fetchUrl;
    if (platformId === 'shopify') {
        fetchUrl = URLUtils.url('Accelerator-FetchShopifyCategories').toString();
    } else if (platformId === 'bigcommerce') {
        fetchUrl = URLUtils.url('Accelerator-FetchBigCommerceCategories').toString();
    } else {
        fetchUrl = URLUtils.url('Accelerator-FetchCTCategories').toString();
    }
    var migrateUrl     = URLUtils.url('Accelerator-RunCategoryMigration').toString()    || '';

    Logger.info('CategoryMigration URLs: migrate={0} impex={1} import={2}',
        migrateUrl, impexFolderUrl, importPageUrl);

    clearModuleAttrIdMap('category');

    ISML.renderTemplate('accelerator/categoryMigration', withBmFrame({
        title          : 'Category Migration',
        subtitle       : '',
        catalogId      : catalogId,
        impexPath      : pageCtx.impexPath,
        dataWizardEntryUrl:  pageCtx.dataWizardEntryUrl,
        dataWizardSelectUrl: pageCtx.dataWizardSelectUrl,
        platformId:          pageCtx.platformId,
        sourceLabel:         pageCtx.sourceLabel,
        migrationUi:         pageCtx.migrationUi,
        migrationUiJson:     pageCtx.migrationUiJson,
        dashboardUrl   : URLUtils.url('Accelerator-Start').toString(),
        cssUrl         : URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        checkAttrsUrl  : checkAttrsUrl,
        checkStatusUrl : checkStatusUrl,
        fetchUrl       : fetchUrl,
        platform       : platformId,
        migrateUrl     : migrateUrl,
        impexFolderUrl : impexFolderUrl,
        importPageUrl  : importPageUrl,
        fetchCatalogsUrl      : URLUtils.url('Accelerator-FetchSFCCCatalogs').toString(),
        createCatalogUrl      : URLUtils.url('Accelerator-CreateCatalog').toString(),
        createCategoryUrl     : URLUtils.url('Accelerator-CreateCategory').toString(),
        bmClientId            : (cfg.sfcc && cfg.sfcc.bmClientId)  ? cfg.sfcc.bmClientId  : '',
        metaVersion           : (cfg.sfcc && cfg.sfcc.metaVersion) ? cfg.sfcc.metaVersion : 'v20_10',
        importUrl             : importPageUrl,
        createCtCategoryUrl   : URLUtils.url('Accelerator-CreateCTCategory').toString(),
        checkProductsUrl      : URLUtils.url('Accelerator-CheckCategoryProducts').toString(),
        attrPreflightJsUrl    : URLUtils.staticURL('/js/attr-preflight.js').toString() + '?v=12',
        createAttrsUrl        : URLUtils.url('Accelerator-CreateCategoryAttributes').toString(),
        deleteAttrUrl         : URLUtils.url('Accelerator-DeleteCategoryAttribute').toString(),
        clearAttrMapUrl       : clearAttrMapUrlFor('category'),
        saveCustomAttrsUrl    : URLUtils.url('Accelerator-SaveCategoryCustomAttrs').toString(),
        jsUrl: URLUtils.url('Accelerator-CategoryMigrationJS').toString() + '?v=' + new Date().getTime()
    }));
};
exports.CategoryMigration.public = true;


/**
 * Check status of required custom attribute definitions on the SFCC Category system object.
 * Returns each attr with an `exists` flag.
 * GET — no params required.
 */
exports.CheckCategoryAttributes = function () {
    try {
        var selectedParam = request.httpParameterMap.selected.stringValue;
        var deleteParam   = request.httpParameterMap.delete.stringValue;

        // No params — return current status
        if (!selectedParam && !deleteParam) {
            var categoryAttributeMgr = require('*/cartridge/scripts/catalog/categoryAttributeMgr');
            var catPlatform = String(session.custom.migrationPlatformId || 'commercetools');
            var result = categoryAttributeMgr.checkAttributes(catPlatform);
            var suggestUrl = URLUtils.url('Accelerator-SuggestAttrMaps').toString();
            response.setContentType('application/json');
            response.writer.print(JSON.stringify({
                ok: true,
                attrs: result.attrs || [],
                mapped: result.mapped || [],
                missing: result.missing || [],
                coveragePending: result.coveragePending || [],
                skipped: result.skipped || [],
                suggested: result.suggested || [],
                aiStatus: (result && result.aiStatus) || 'skipped',
                aiMessage: (result && result.aiMessage) || '',
                taskName: (result && result.taskName) || 'Category',
                sfccObjectType: (result && result.sfccObjectType) || 'Category',
                suggestAttrMapsUrl: suggestUrl,
                sessionSystemMaps: []
            }));
            return;
        }

        var sfccClient = require('*/cartridge/scripts/migration/sfccClient');
        var token      = sfccClient.getSFCCToken();

        // Delete param — delete selected attributes
        if (deleteParam) {
            var toDelete = JSON.parse(deleteParam);
            var deleted  = 0;
            var dFailed  = 0;
            var dErrors  = [];
            for (var d = 0; d < toDelete.length; d++) {
                try {
                    sfccClient.deleteAttributeDefinition(token, 'Category', toDelete[d]);
                    deleted++;
                } catch (de) {
                    dFailed++;
                    dErrors.push(toDelete[d] + ': ' + (de.message || String(de)));
                }
            }
            response.setContentType('application/json');
            response.writer.print(JSON.stringify({ ok: dFailed === 0, deleted: deleted, failed: dFailed, errors: dErrors }));
            return;
        }

        // Selected param — create selected attributes
        var selected    = JSON.parse(selectedParam);
        var attrBuilder = require('*/cartridge/scripts/migration/core/attrBuilder');
        var existingIds = sfccClient.getExistingAttributeIds(token, 'Category');
        var created = 0; var skipped = 0; var failed = 0; var errors = [];
        var selPlatform = String(session.custom.migrationPlatformId || 'commercetools');
        var catAttrMgrSel = require('*/cartridge/scripts/catalog/categoryAttributeMgr');
        var selGroup = catAttrMgrSel.getAttrGroup(selPlatform);

        try { sfccClient.ensureAttributeGroup(token, 'Category', selGroup.id, selGroup.name); } catch (ge) {}

        for (var i = 0; i < selected.length; i++) {
            var a = selected[i];
            if (existingIds[a.id]) {
                skipped++;
            } else {
                try {
                    var def = attrBuilder.buildAttrDefinition(a.id, a.sfccType, a.label);
                    sfccClient.createAttributeDefinition(token, 'Category', def);
                    created++;
                } catch (e) {
                    failed++;
                    if (errors.length < 5) errors.push(a.id + ': ' + (e.message || String(e)));
                }
            }
            try { sfccClient.addAttributeToGroup(token, 'Category', selGroup.id, a.id); } catch (age) {}
        }

        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: failed === 0, created: created, skipped: skipped, failed: failed, errors: errors }));

    } catch (e) {
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
};
exports.CheckCategoryAttributes.public = true;

/**
 * Create selected attribute definitions on the SFCC Category system object.
 * POST: attrs=<json-array of {id, label, sfccType}>
 */
exports.CreateCategoryAttributes = function () {
    var rawAttrs = getParam('attrs');
    var attrs    = [];
    try { attrs = JSON.parse(rawAttrs || '[]'); } catch (e) {
        jsonResponse({ ok: false, error: 'Invalid attrs JSON' });
        return;
    }
    if (!attrs.length) {
        jsonResponse({ ok: false, error: 'No attributes provided' });
        return;
    }
    try {
        var catAttrMgr   = require('*/cartridge/scripts/catalog/categoryAttributeMgr');
        var catPlatform  = String(session.custom.migrationPlatformId || 'commercetools');
        var result = catAttrMgr.createAttributes(attrs, catPlatform);
        if (result && result.mappedAttrs && result.mappedAttrs.length) {
            require('*/cartridge/scripts/migration/core/attrIdMapSession').saveFromAttrs('category', result.mappedAttrs);
        }
        // Persist canonical→actual ID mapping in session so RunCategoryMigration
        // can remap customAttribute keys even when the user navigates across pages.
        // Always write the session key (even when no rename) so stale mappings are
        // cleared if the user re-creates an attribute back under its canonical name.
        for (var i = 0; i < attrs.length; i++) {
            var canonicalAttrId = attrs[i].canonicalId || attrs[i].id;
            if (canonicalAttrId) {
                if (attrs[i].id && attrs[i].id !== canonicalAttrId) {
                    session.custom['catAttrMap_' + canonicalAttrId] = attrs[i].id;
                } else {
                    session.custom['catAttrMap_' + canonicalAttrId] = '';
                }
            }
        }
        jsonResponse({ ok: true, result: result });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateCategoryAttributes.public = true;

/**
 * Alias used by the attribute status widget (same as CheckCategoryAttributes).
 * GET — no params required.
 */
exports.CheckAttributeStatus = function () {
    var categoryAttributeMgr = require('*/cartridge/scripts/catalog/categoryAttributeMgr');
    try {
        var statusPlatform = String(session.custom.migrationPlatformId || 'commercetools');
        var result = categoryAttributeMgr.checkAttributes(statusPlatform);
        var attrs  = result.attrs || result;
        var status = {};
        for (var i = 0; i < attrs.length; i++) {
            status[attrs[i].id] = attrs[i].exists ? 'exists' : 'missing';
        }
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: true, status: status }));
    } catch (e) {
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.CheckAttributeStatus.public = true;

/**
 * Delete a single custom attribute definition from the SFCC Category system object.
 * POST: attrId=<attribute-id>
 */
exports.DeleteCategoryAttribute = function () {
    var attrId = getParam('attrId');
    if (!attrId) {
        jsonResponse({ ok: false, error: 'attrId is required' });
        return;
    }
    try {
        var sfccClient = require('*/cartridge/scripts/migration/sfccClient');
        var token = sfccClient.getSFCCToken();
        sfccClient.deleteAttributeDefinition(token, 'Category', attrId);
        jsonResponse({ ok: true, deleted: attrId });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.DeleteCategoryAttribute.public = true;

/**
 * GET: Fetch discovered CT custom-Type fields for the category object
 * POST: Save the user's selection of CT custom-Type fields to include in XML
 * POST: attrs=<JSON array of field names to include>
 */
exports.SaveCategoryCustomAttrs = function () {
    response.setContentType('application/json');

    try {
        var attrsJsonParam = null;
        if (request.httpParameterMap.attrs) {
            attrsJsonParam = request.httpParameterMap.attrs.stringValue;
        }

        // POST request — save the selection
        if (attrsJsonParam) {
            var selected = [];
            try {
                selected = JSON.parse(attrsJsonParam);
            } catch (pe) {
                selected = [];
            }
            session.custom.selectedCategoryCustomAttrs = JSON.stringify(selected);
            response.writer.print(JSON.stringify({ ok: true, saved: selected.length }));
            return;
        }

        // GET request — fetch available CT custom-Type fields
        var savedSelection = [];
        try {
            var saved = session.custom.selectedCategoryCustomAttrs;
            if (saved) {
                savedSelection = JSON.parse(saved);
            }
        } catch (e) {
            savedSelection = [];
        }

        var customFields = [];
        var catPlatform = String(session.custom.migrationPlatformId || 'commercetools');

        if (catPlatform === 'commercetools') {
            try {
                var categoryAttributeMgr = require('*/cartridge/scripts/catalog/categoryAttributeMgr');
                customFields = categoryAttributeMgr.getCtpCategoryTypeFields() || [];
            } catch (ctErr) {
                customFields = [];
            }
        }

        response.writer.print(JSON.stringify({
            ok: true,
            attrs: customFields,
            savedSelection: savedSelection
        }));

    } catch (e) {
        response.writer.print(JSON.stringify({
            ok: false,
            error: e.message || 'Unknown error'
        }));
    }
};
exports.SaveCategoryCustomAttrs.public = true;


// Fetch all available SFCC catalogs using native CatalogMgr (no credentials needed)
exports.FetchSFCCCatalogs = function () {
    try {
        var sfccClient  = require('*/cartridge/scripts/migration/sfccClient');
        var cfg         = require('*/cartridge/scripts/migration/configAccessor');
        var base        = 'https://' + request.httpHost;
        var version     = (cfg.sfcc && cfg.sfcc.metaVersion) ? cfg.sfcc.metaVersion : 'v25_6';
        var clientId    = (cfg.sfcc && cfg.sfcc.bmClientId) ? cfg.sfcc.bmClientId : '';

        var token = sfccClient.getSFCCToken();
        var url   = base + '/s/-/dw/data/' + version + '/catalogs?client_id=' + encodeURIComponent(clientId) + '&count=200';

        var res = sfccClient.doGet(url, token);
        var data = res.data || {};

        if (res.status !== 200 || !data.data) {
            // Fallback to CatalogMgr if OCAPI fails
            var CatalogMgr = require('dw/catalog/CatalogMgr');
            var Site       = require('dw/system/Site');
            var result     = [];
            var seen       = {};
            function addCat(cat) {
                if (cat && !seen[cat.ID]) {
                    seen[cat.ID] = true;
                    result.push({ id: cat.ID, name: cat.displayName ? cat.displayName.toString() : cat.ID });
                }
            }
            addCat(CatalogMgr.getSiteCatalog());
            var sites = Site.getAllSites();
            var sit = sites.iterator();
            while (sit.hasNext()) { try { addCat(sit.next().getCatalog()); } catch (se) {} }
            jsonResponse({ ok: true, catalogs: result, total: result.length });
            return;
        }

        var catalogs = data.data.map(function (c) {
            var name = (c.name && (c.name['default'] || c.name['x-default'])) || c.id;
            return { id: c.id, name: name };
        });

        jsonResponse({ ok: true, catalogs: catalogs, total: catalogs.length });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FetchSFCCCatalogs.public = true;



// Create new catalog XML and write to IMPEX
exports.CreateCatalog = function () {
    var catalogId   = request.httpParameterMap.catalogId.stringValue   || '';
    var catalogName = request.httpParameterMap.catalogName.stringValue || '';

    if (!catalogId || !catalogName) {
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: false, error: 'catalogId and catalogName are required' }));
        return;
    }

    try {
        var File       = require('dw/io/File');
        var FileWriter = require('dw/io/FileWriter');

        var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31" catalog-id="' + catalogId + '">\n'
            + '    <header>\n'
            + '        <image-settings>\n'
            + '            <internal-location base-path="/images"/>\n'
            + '            <view-types>\n'
            + '                <view-type>small</view-type>\n'
            + '                <view-type>medium</view-type>\n'
            + '                <view-type>large</view-type>\n'
            + '            </view-types>\n'
            + '        </image-settings>\n'
            + '    </header>\n'
            + '    <category category-id="root">\n'
            + '        <display-name xml:lang="x-default">' + catalogName + '</display-name>\n'
            + '        <online-flag>true</online-flag>\n'
            + '    </category>\n'
            + '</catalog>';

        var migPaths = require('*/cartridge/scripts/migration/core/migrationPaths');
        var relPath  = migPaths.getRelativePath('catalog');
        var dir      = new File(File.IMPEX + File.SEPARATOR + relPath.replace(/\//g, File.SEPARATOR));
        if (!dir.exists()) { dir.mkdirs(); }

        var fileName = 'new-catalog-' + catalogId + '.xml';
        var filePath = File.IMPEX + File.SEPARATOR + relPath.replace(/\//g, File.SEPARATOR) + File.SEPARATOR + fileName;
        var file     = new File(filePath);
        var writer   = new FileWriter(file, 'UTF-8');
        writer.write(xml);
        writer.close();

        response.setContentType('application/json');
        response.writer.print(JSON.stringify({
            ok     : true,
            xmlPath: 'IMPEX/' + relPath + '/' + fileName
        }));
    } catch (e) {
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.CreateCatalog.public = true;

// Create a new SFCC catalog directly via OCAPI
exports.CreateCatalogOCAPI = function () {
    var catalogId   = getParam('catalogId');
    var catalogName = getParam('catalogName');

    if (!catalogId || !catalogName) {
        jsonResponse({ ok: false, error: 'catalogId and catalogName are required' });
        return;
    }

    try {
        var cfg        = require('*/cartridge/scripts/migration/configAccessor');
        var sfccClient = require('*/cartridge/scripts/migration/sfccClient');
        var metaVersion = (cfg.sfcc && cfg.sfcc.metaVersion) ? cfg.sfcc.metaVersion : 'v25_6';
        var bmClientId  = (cfg.sfcc && cfg.sfcc.bmClientId)  ? cfg.sfcc.bmClientId  : '';
        var baseUrl     = 'https://' + request.httpHost;
        var base        = baseUrl + '/s/-/dw/data/' + metaVersion;
        var qs          = '?client_id=' + encodeURIComponent(bmClientId);
        var token       = sfccClient.getSFCCToken();
        var payload     = { id: catalogId, name: { default: catalogName } };
        var catalogUrl  = base + '/catalogs/' + encodeURIComponent(catalogId) + qs;

        var postRes = sfccClient.doPost(base + '/catalogs' + qs, token, payload);
        if (postRes.status === 200 || postRes.status === 201) {
            jsonResponse({ ok: true, id: catalogId, name: catalogName, method: 'POST' });
            return;
        }

        var putRes = sfccClient.doPut(catalogUrl, token, payload);
        if (putRes.status === 200 || putRes.status === 201) {
            jsonResponse({ ok: true, id: catalogId, name: catalogName, method: 'PUT' });
            return;
        }

        jsonResponse({
            ok: false,
            error: 'Catalog create failed (POST ' + postRes.status + ', PUT ' + putRes.status + ')'
        });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.CreateCatalogOCAPI.public = true;

// Create new category in SFCC via CatalogMgr
exports.CreateCategory = function () {
    var catalogId    = request.httpParameterMap.catalogId.stringValue    || '';
    var categoryId   = request.httpParameterMap.categoryId.stringValue   || '';
    var categoryName = request.httpParameterMap.categoryName.stringValue || '';
    var parentId     = request.httpParameterMap.parentId.stringValue     || 'root';

    if (!catalogId || !categoryId || !categoryName) {
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: false, error: 'catalogId, categoryId and categoryName are required' }));
        return;
    }

    try {
        var File       = require('dw/io/File');
        var FileWriter = require('dw/io/FileWriter');

        var parentBlock = '';
        if (parentId && parentId !== 'root') {
            parentBlock = '        <parent>' + parentId + '</parent>\n';
        }

        var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<catalog xmlns="http://www.demandware.com/xml/impex/catalog/2006-10-31" catalog-id="' + catalogId + '">\n'
            + '    <category category-id="' + categoryId + '">\n'
            + '        <display-name xml:lang="x-default">' + categoryName + '</display-name>\n'
            + '        <online-flag>true</online-flag>\n'
            + parentBlock
            + '    </category>\n'
            + '</catalog>';

        var fileName = 'new-category-' + categoryId + '.xml';
        var file     = new File(File.IMPEX + '/src/catalog/' + fileName);
        var writer   = new FileWriter(file, 'UTF-8');
        writer.write(xml);
        writer.close();

        response.setContentType('application/json');
        response.writer.print(JSON.stringify({
            ok      : true,
            xmlPath : 'IMPEX/src/catalog/' + fileName,
            message : 'XML written to IMPEX/src/catalog/' + fileName + '. Import via Administration - Site Development - Import and Export to create the category.'
        }));
    } catch (e) {
        response.setContentType('application/json');
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.CreateCategory.public = true;

exports.FetchCTCategories = function () {
    var platform = String(session.custom.migrationPlatformId || 'commercetools');

    // SAP Commerce — handled inside this endpoint so no new route is needed
    if (platform === 'sap') {
        try {
            var fetchSAP = require('~/cartridge/scripts/catalog/fetchSAPCategories');
            var sapOffset = parseInt(request.httpParameterMap.offset.stringValue || '0', 10) || 0;
            var sapPage   = fetchSAP.fetchCategoriesPage(sapOffset);
            jsonResponse({
                ok        : true,
                categories: sapPage.results,
                offset    : sapOffset,
                limit     : 200,
                total     : sapPage.total,
                done      : sapPage.done
            });
        } catch (e) {
            jsonResponse({ ok: false, error: e.message || String(e) });
        }
        return;
    }

    var fetchCT   = require('~/cartridge/scripts/catalog/fetchCTCategories');
    var transform = require('~/cartridge/scripts/catalog/transformCategories');
    var Logger    = require('dw/system/Logger');

    response.setContentType('application/json');

    try {
        var defaultLocale = request.httpParameterMap.locale.stringValue  || 'en';
        var offset        = parseInt(request.httpParameterMap.offset.stringValue || '0', 10) || 0;
        var limit         = 500;

        var token = fetchCT.getCTAuthToken();
        if (!token) {
            response.writer.print(JSON.stringify({ ok: false, error: 'CT auth failed' }));
            return;
        }

        // Fetch one page only
        var page = fetchCT.fetchCategoriesPage(token, limit, offset);

        var list = page.results.map(function (cat) {
            var sfcc = transform.transformCategory(cat, defaultLocale, page.idToKey);
            return { id: sfcc.id, name: sfcc.name['x-default'] || sfcc.id, parentId: sfcc.parentId, position: sfcc.position };
        });

        response.writer.print(JSON.stringify({
            ok        : true,
            categories: list,
            offset    : offset,
            limit     : limit,
            total     : page.total,
            done      : (offset + list.length) >= page.total
        }));
    } catch (e) {
        Logger.error('FetchCTCategories error: {0}', e.message);
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.FetchCTCategories.public = true;

exports.FetchShopifyCategories = function () {
    var fetchShopify = require('~/cartridge/scripts/catalog/fetchShopifyCategories');
    var Logger       = require('dw/system/Logger');

    response.setContentType('application/json');

    try {
        var cursor = request.httpParameterMap.offset.stringValue || '0';
        var page   = fetchShopify.fetchCollectionsPage(cursor);

        response.writer.print(JSON.stringify({
            ok         : true,
            categories : page.results,
            nextOffset : page.nextCursor || '',
            done       : page.done
        }));
    } catch (e) {
        Logger.error('FetchShopifyCategories error: {0}', e.message);
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.FetchShopifyCategories.public = true;

exports.FetchBigCommerceCategories = function () {
    var fetchBC = require('~/cartridge/scripts/catalog/fetchBigCommerceCategories');
    var Logger  = require('dw/system/Logger');

    response.setContentType('application/json');

    try {
        var cursor = request.httpParameterMap.offset.stringValue || '0';
        var page   = fetchBC.fetchCollectionsPage(cursor);

        response.writer.print(JSON.stringify({
            ok         : true,
            categories : page.results,
            nextOffset : page.nextCursor || '',
            done       : page.done
        }));
    } catch (e) {
        Logger.error('FetchBigCommerceCategories error: {0}', e.message);
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.FetchBigCommerceCategories.public = true;

exports.FetchSAPCategories = function () {
    jsonResponse({ ok: false, error: 'DIAGNOSTIC: endpoint reached, SAP not called yet' });
};
exports.FetchSAPCategories.public = true;

/**
 * Check which categories have products assigned in Shopify.
 * Queries products and their category assignments via GraphQL.
 * Returns { ok: true, counts: { "Category Name": productCount } }
 */
exports.CheckCategoryProducts = function () {
    var connector   = require('~/cartridge/scripts/migration/connectors/shopify/shopifyConnector');
    var cfgAccessor = require('*/cartridge/scripts/migration/configAccessor');
    var http        = require('*/cartridge/scripts/migration/core/http');
    var Logger      = require('dw/system/Logger');

    response.setContentType('application/json');

    try {
        var creds   = cfgAccessor.shopify || {};
        var base    = connector.getAdminBase(creds);
        var hdrs    = connector.getAuthHeaders(creds);
        var counts  = {};
        var cursor  = null;
        var hasMore = true;
        var maxPages = 10;

        while (hasMore && maxPages-- > 0) {
            var afterClause = cursor
                ? '(first:250,after:"' + cursor + '")'
                : '(first:250)';
            var query = '{ products' + afterClause + ' { nodes { id category { id name fullName } } pageInfo { hasNextPage endCursor } } }';
            var res   = http.post(base + '/graphql.json', hdrs, JSON.stringify({ query: query }));

            if (res.status !== 200) { break; }
            var resData  = res.data || {};
            if (resData.errors && resData.errors.length) { break; }
            var prods    = (resData.data && resData.data.products && resData.data.products.nodes) || [];
            var pageInfo = (resData.data && resData.data.products && resData.data.products.pageInfo) || {};

            for (var pi = 0; pi < prods.length; pi++) {
                var prod = prods[pi];
                if (prod.category && prod.category.name) {
                    var catName = String(prod.category.name);
                    counts[catName] = (counts[catName] || 0) + 1;
                }
            }

            hasMore = !!pageInfo.hasNextPage;
            cursor  = pageInfo.endCursor || null;
        }

        Logger.info('CheckCategoryProducts: {0} categories have products', Object.keys(counts).length);
        response.writer.print(JSON.stringify({ ok: true, counts: counts }));
    } catch (e) {
        Logger.error('CheckCategoryProducts error: {0}', e.message);
        response.writer.print(JSON.stringify({ ok: false, error: e.message, counts: {} }));
    }
};
exports.CheckCategoryProducts.public = true;



/**
 * Create a new category in CommerceTools.
 * POST — params: key, name, parentId (optional)
 */
exports.CreateCTCategory = function () {
    var fetchCT = require('~/cartridge/scripts/catalog/fetchCTCategories');
    var cfg     = require('*/cartridge/scripts/migration/configAccessor');
    var Logger  = require('dw/system/Logger');

    response.setContentType('application/json');

    var key      = request.httpParameterMap.key.stringValue      || '';
    var name     = request.httpParameterMap.name.stringValue     || '';
    var parentId = request.httpParameterMap.parentId.stringValue || '';

    if (!key || !name) {
        response.writer.print(JSON.stringify({ ok: false, error: 'key and name are required' }));
        return;
    }

    try {
        var token = fetchCT.getCTAuthToken();
        if (!token) {
            response.writer.print(JSON.stringify({ ok: false, error: 'CT auth failed' }));
            return;
        }

        var c      = cfg.ctp;
        var apiUrl = c.apiUrl + '/' + c.projectKey + '/categories';
        var slug   = key.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        var body = {
            key  : key,
            name : { 'en-US': name },
            slug : { 'en-US': slug }
        };
        if (parentId) {
            body.parent = { id: parentId, typeId: 'category' };
        }

        var serviceHttp = require('*/cartridge/scripts/migration/core/serviceHttp');
        var res = serviceHttp.post('ctp', apiUrl, {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        }, JSON.stringify(body));

        var sc   = res.status;
        var data = res.data || {};

        if (sc === 200 || sc === 201) {
            response.writer.print(JSON.stringify({
                ok      : true,
                id      : data.key || key,
                name    : name,
                parentId: parentId || ''
            }));
        } else {
            var errMsg = (data.message || (data.errors && data.errors[0] && data.errors[0].message)) || ('HTTP ' + sc);
            response.writer.print(JSON.stringify({ ok: false, error: errMsg }));
        }
    } catch (e) {
        Logger.error('CreateCTCategory error: {0}', e.message);
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.CreateCTCategory.public = true;

/**
 * Run category migration — stub endpoint for future implementation.
 * POST — no params required.
 */
// Make sure this export name matches the URL above
exports.RunCategoryMigration = function () {
    var Logger     = require('dw/system/Logger');
    var fetchCT    = require('~/cartridge/scripts/catalog/fetchCTCategories');
    var transform  = require('~/cartridge/scripts/catalog/transformCategories');
    var xmlBuilder = require('~/cartridge/scripts/helpers/catalogXmlBuilder');
    var importer   = require('~/cartridge/scripts/catalog/importCategories');
    var File       = require('dw/io/File');
    var FileWriter = require('dw/io/FileWriter');

    response.setContentType('application/json');

    var mode      = request.httpParameterMap.mode.stringValue      || 'xml';
    var catalogId = request.httpParameterMap.catalogId.stringValue || 'storefront-catalog-m-en';
    var locale    = request.httpParameterMap.locale.stringValue    || 'en-US';
    var platform  = request.httpParameterMap.platform.stringValue  || String(session.custom.migrationPlatformId || 'commercetools');

    var overridesRaw = request.httpParameterMap.overrides.stringValue || '{}';
    var overrides    = {};
    try { overrides = JSON.parse(overridesRaw); } catch (e) { overrides = {}; }

    var extraRaw    = request.httpParameterMap.extraCategories.stringValue || '[]';
    var extraCats   = [];
    try { extraCats = JSON.parse(extraRaw); } catch (e) { extraCats = []; }

    var selectedIdsRaw = request.httpParameterMap.selectedIds.stringValue || '';
    var selectedIds    = [];
    try { if (selectedIdsRaw) { selectedIds = JSON.parse(selectedIdsRaw); } } catch (sie) { selectedIds = []; }

    var categoriesDataRaw = request.httpParameterMap.categoriesData.stringValue || '';
    var clientCategories  = [];
    try { if (categoriesDataRaw) { clientCategories = JSON.parse(categoriesDataRaw); } } catch (cde) { clientCategories = []; }

    try {
        var sfccCategories = [];

        if (platform === 'shopify') {
            // ── Shopify path ──────────────────────────────────────────────────
            var fetchShopify = require('~/cartridge/scripts/catalog/fetchShopifyCategories');
            var taxonomyData = require('~/cartridge/scripts/catalog/shopifyTaxonomyData');

            var allTaxonomy = [];

            if (clientCategories.length > 0) {
                // Client already fetched all levels in Step 2 — use that data directly.
                // This avoids re-fetching from Shopify server-side, which would hit
                // SFCC's 16 HTTP calls/request limit for large taxonomies.
                allTaxonomy = clientCategories;
                Logger.info('RunCategoryMigration: using {0} client-sent categories', allTaxonomy.length);
            } else {
                var connector   = require('~/cartridge/scripts/migration/connectors/shopify/shopifyConnector');
                var cfgAccessor = require('*/cartridge/scripts/migration/configAccessor');
                try {
                    var creds    = cfgAccessor.shopify || {};
                    var base     = connector.getAdminBase(creds);
                    var hdrs     = connector.getAuthHeaders(creds);
                    var allNodes = fetchShopify.fetchAllAPINodes(base, hdrs);

                    if (allNodes.length > 0 && fetchShopify.hasSubcategories(allNodes)) {
                        allTaxonomy = fetchShopify.transformAPINodes(allNodes);
                        Logger.info('RunCategoryMigration: API multi-level, {0} categories', allTaxonomy.length);
                    } else {
                        allTaxonomy = taxonomyData.TAXONOMY.slice();
                        if (allNodes.length > 0) {
                            var staticIds = {};
                            allTaxonomy.forEach(function (c) { staticIds[c.id] = true; });
                            allNodes.forEach(function (n) {
                                var slug = String(n.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                                if (slug && !staticIds[slug]) {
                                    allTaxonomy.push({ id: slug, name: String(n.name || ''), parentId: '' });
                                }
                            });
                        }
                        Logger.info('RunCategoryMigration: static taxonomy, {0} categories', allTaxonomy.length);
                    }
                } catch (apiErr) {
                    Logger.warn('RunCategoryMigration Shopify API fetch error: {0} — falling back to static taxonomy', apiErr.message);
                    allTaxonomy = taxonomyData.TAXONOMY.slice();
                }
            }

            // Filter to user-selected categories if a selection was provided
            if (selectedIds.length > 0) {
                var selSet = {};
                for (var si = 0; si < selectedIds.length; si++) { selSet[selectedIds[si]] = true; }
                allTaxonomy = allTaxonomy.filter(function (tc) { return selSet[tc.id]; });
            }

            // Build lookup map and child-presence map for level + isLeaf computation
            var taxMap      = {};
            var hasChildren = {};
            for (var ti2 = 0; ti2 < allTaxonomy.length; ti2++) {
                taxMap[allTaxonomy[ti2].id] = allTaxonomy[ti2];
            }
            for (var ti3 = 0; ti3 < allTaxonomy.length; ti3++) {
                var pid = allTaxonomy[ti3].parentId;
                if (pid) { hasChildren[pid] = true; }
            }

            function getTaxLevel(id, visited) {
                if (!id || visited[id]) return 1;
                visited[id] = true;
                var node = taxMap[id];
                if (!node || !node.parentId) return 1;
                return 1 + getTaxLevel(node.parentId, visited);
            }

            // Transform flat taxonomy into SFCC category format
            for (var ti = 0; ti < allTaxonomy.length; ti++) {
                var tc = allTaxonomy[ti];
                var nameObj = {};
                nameObj[locale] = tc.name || tc.id;
                sfccCategories.push({
                    id              : tc.id,
                    parentId        : tc.parentId || 'root',
                    name            : nameObj,
                    description     : {},
                    pageTitle       : {},
                    pageDescription : {},
                    position        : ti + 1,
                    online          : true,
                    customAttributes: {
                        level : getTaxLevel(tc.id, {}),
                        isLeaf: !hasChildren[tc.id]
                    }
                });
            }

            Logger.info('RunCategoryMigration Shopify: {0} categories', sfccCategories.length);

        } else if (platform === 'bigcommerce') {
            // ── BigCommerce path ──────────────────────────────────────────────
            var fetchBC = require('~/cartridge/scripts/catalog/fetchBigCommerceCategories');
            var allBcCats = [];

            if (clientCategories.length > 0) {
                allBcCats = clientCategories;
                Logger.info('RunCategoryMigration: using {0} client-sent BigCommerce categories', allBcCats.length);
            } else {
                var bcCursor = '0';
                var bcDone   = false;
                var bcGuard  = 0;
                while (!bcDone && bcGuard < 200) {
                    bcGuard++;
                    var bcPage = fetchBC.fetchCollectionsPage(bcCursor);
                    var bcBatch = bcPage.results || [];
                    for (var bci = 0; bci < bcBatch.length; bci++) {
                        allBcCats.push(bcBatch[bci]);
                    }
                    bcDone = !!bcPage.done;
                    bcCursor = bcPage.nextCursor || '';
                    if (!bcDone && !bcCursor) break;
                }
                Logger.info('RunCategoryMigration: fetched {0} BigCommerce categories', allBcCats.length);
            }

            if (selectedIds.length > 0) {
                var selSetBC = {};
                for (var siBC = 0; siBC < selectedIds.length; siBC++) { selSetBC[selectedIds[siBC]] = true; }
                allBcCats = allBcCats.filter(function (tc) { return selSetBC[tc.id]; });
            }

            var bcTaxMap      = {};
            var bcHasChildren = {};
            for (var bti2 = 0; bti2 < allBcCats.length; bti2++) {
                bcTaxMap[allBcCats[bti2].id] = allBcCats[bti2];
            }
            for (var bti3 = 0; bti3 < allBcCats.length; bti3++) {
                var bpid = allBcCats[bti3].parentId;
                if (bpid) { bcHasChildren[bpid] = true; }
            }

            function getBcTaxLevel(id, visited) {
                if (!id || visited[id]) return 1;
                visited[id] = true;
                var node = bcTaxMap[id];
                if (!node || !node.parentId) return 1;
                return 1 + getBcTaxLevel(node.parentId, visited);
            }

            for (var bti = 0; bti < allBcCats.length; bti++) {
                var btc = allBcCats[bti];
                var bcNameObj = {};
                bcNameObj[locale] = btc.name || btc.id;
                sfccCategories.push({
                    id              : btc.id,
                    parentId        : btc.parentId || 'root',
                    name            : bcNameObj,
                    description     : {},
                    pageTitle       : {},
                    pageDescription : {},
                    position        : bti + 1,
                    online          : true,
                    customAttributes: {
                        level : getBcTaxLevel(btc.id, {}),
                        isLeaf: !bcHasChildren[btc.id]
                    }
                });
            }

            Logger.info('RunCategoryMigration BigCommerce: {0} categories', sfccCategories.length);

        } else if (platform === 'sap') {
            // ── SAP Commerce Cloud path ───────────────────────────────────────
            var fetchSAP2 = require('~/cartridge/scripts/catalog/fetchSAPCategories');

            var sapCats = clientCategories.length > 0 ? clientCategories : fetchSAP2.fetchAllCategories();
            if (!sapCats || sapCats.length === 0) {
                response.writer.print(JSON.stringify({ ok: false, error: 'No categories returned from SAP.' }));
                return;
            }

            if (selectedIds.length > 0) {
                var selSetSAP = {};
                for (var siSAP = 0; siSAP < selectedIds.length; siSAP++) { selSetSAP[selectedIds[siSAP]] = true; }
                sapCats = sapCats.filter(function (c) { return selSetSAP[c.id]; });
            }

            for (var sapi = 0; sapi < sapCats.length; sapi++) {
                var sc      = sapCats[sapi];
                var scName  = {};
                scName[locale] = sc.name || sc.id;
                sfccCategories.push({
                    id              : sc.id,
                    parentId        : sc.parentId || 'root',
                    name            : scName,
                    description     : sc.description ? { 'x-default': sc.description } : {},
                    pageTitle       : {},
                    pageDescription : {},
                    position        : sapi + 1,
                    online          : true,
                    customAttributes: { sapCode: sc.sapCode || sc.id }
                });
            }

            Logger.info('RunCategoryMigration SAP: {0} categories', sfccCategories.length);

        } else {
            // ── CommerceTools path ────────────────────────────────────────────
            var token = fetchCT.getCTAuthToken();
            if (!token) {
                response.writer.print(JSON.stringify({ ok: false, error: 'CT auth failed.' }));
                return;
            }

            var ctCategories = fetchCT.fetchAllCategories(token);
            if (!ctCategories || ctCategories.length === 0) {
                response.writer.print(JSON.stringify({ ok: false, error: 'No categories returned from CT.' }));
                return;
            }

            sfccCategories = transform.transformAll(ctCategories, locale);

            // Filter to user-selected categories if a selection was provided
            if (selectedIds.length > 0) {
                var selSet2 = {};
                for (var si2 = 0; si2 < selectedIds.length; si2++) { selSet2[selectedIds[si2]] = true; }
                sfccCategories = sfccCategories.filter(function (cat) { return selSet2[cat.id]; });
            }
        }

        // Append locally-added categories
        for (var ei = 0; ei < extraCats.length; ei++) {
            var ec = extraCats[ei];
            if (!ec || !ec.id) continue;
            var ecName = {};
            ecName[locale] = ec.name || ec.id;
            sfccCategories.push({
                id              : ec.id,
                parentId        : ec.parentId || 'root',
                name            : ecName,
                description     : {},
                pageTitle       : {},
                pageDescription : {},
                position        : sfccCategories.length + 1,
                online          : true,
                customAttributes: {}
            });
        }

        // Apply user-edited attribute ID mapping (from Step 1 edits)
        var attrIdsRaw = request.httpParameterMap.attrIds.stringValue || '{}';
        var attrIds    = {};
        try { attrIds = JSON.parse(attrIdsRaw); } catch (aie) {}

        // Merge session-stored mapping as fallback for keys not provided by client.
        // This handles the cross-session case where the user navigates away after Step 1
        // and returns directly to Step 3 — the attr table is empty so client sends no mapping.
        var CANONICAL_ATTRS = ['level', 'isLeaf', 'sapCode'];
        for (var cai = 0; cai < CANONICAL_ATTRS.length; cai++) {
            var cKey = CANONICAL_ATTRS[cai];
            if (!attrIds[cKey]) {
                var sessionMapped = String(session.custom['catAttrMap_' + cKey] || '');
                if (sessionMapped && sessionMapped !== cKey) {
                    attrIds[cKey] = sessionMapped;
                }
            }
        }

        var attrIdKeys = Object.keys(attrIds);
        if (attrIdKeys.length > 0) {
            sfccCategories.forEach(function (cat) {
                var ca    = cat.customAttributes || {};
                var newCa = {};
                Object.keys(ca).forEach(function (origKey) {
                    var mappedKey = attrIds[origKey];
                    newCa[mappedKey && mappedKey.trim() ? mappedKey.trim() : origKey] = ca[origKey];
                });
                cat.customAttributes = newCa;
            });
        }

        // Apply overrides to all categories (CT + new) so parent changes work for both
        sfccCategories.forEach(function (cat) {
            var ov = overrides[cat.id];
            if (!ov) return;
            if (ov.parent   !== undefined && ov.parent   !== null) cat.parentId = ov.parent;
            if (ov.position !== undefined && ov.position !== null) cat.position = parseFloat(ov.position);
        });

        // Re-sort
        var idMap = {};
        sfccCategories.forEach(function (c) { idMap[c.id] = c; });

        function getDepth(cat, visited) {
            visited = visited || {};
            if (visited[cat.id]) return 0;
            visited[cat.id] = true;
            if (!cat.parentId || cat.parentId === 'root') return 0;
            var parent = idMap[cat.parentId];
            return parent ? 1 + getDepth(parent, visited) : 1;
        }

        sfccCategories.sort(function (a, b) {
            var da = getDepth(a);
            var db = getDepth(b);
            if (da !== db) return da - db;
            if (a.parentId === b.parentId) return (a.position || 0) - (b.position || 0);
            return 0;
        });

        if (mode === 'xml') {
            var fileResolver = require('*/cartridge/scripts/migration/core/migrationFileResolver');
            var migPaths     = require('*/cartridge/scripts/migration/core/migrationPaths');
            var relPath      = migPaths.getRelativePath('catalog');
            var dir          = new File(File.IMPEX + File.SEPARATOR + relPath.replace(/\//g, File.SEPARATOR));
            if (!dir.exists()) { dir.mkdirs(); }

            var fileName = fileResolver.resolveXmlFileName('catalog', 0, 1, 'local');
            var filePath = File.IMPEX + File.SEPARATOR + relPath.replace(/\//g, File.SEPARATOR)
                + File.SEPARATOR + fileName;
            var writer   = new FileWriter(new File(filePath), 'UTF-8');
            writer.write(xmlBuilder.buildCatalogXml(catalogId, sfccCategories));
            writer.close();

            response.writer.print(JSON.stringify({
                ok:       true,
                mode:     'xml',
                total:    sfccCategories.length,
                fileName: fileName,
                impexPath: relPath,
                xmlPath:  filePath,
                message:  'XML exported successfully (' + sfccCategories.length + ' categories).'
            }));

        } else {
            var ir = importer.importAllCategories(sfccCategories, catalogId);
            response.writer.print(JSON.stringify({
                ok     : true,
                mode   : 'ocapi',
                total  : sfccCategories.length,
                success: ir.success,
                failed : ir.failed,
                errors : ir.errors || []
            }));
        }

    } catch (e) {
        Logger.error('RunCategoryMigration error: {0}\n{1}', e.message, e.stack);
        response.writer.print(JSON.stringify({ ok: false, error: e.message }));
    }
};
exports.RunCategoryMigration.public = true;

// ─── Amplience CMS / content migration ────────────────────────────────────────

exports.ContentMigration = function () {
    var platformId = getParam('platform') || 'amplience';
    session.custom.migrationPlatformId = platformId;

    var platform = migrationData.getPlatform(platformId);
    if (!platform || platform.kind !== 'cms') {
        response.redirect(URLUtils.url('Accelerator-Start'));
        return;
    }

    var pageCtx = migrationPageContext(platformId, 'content');
    var dataConnected = dataMigrationSession.isConnected(platformId);
    var migCfg = require('*/cartridge/scripts/migration/configAccessor');
    var defaultDeliveryKey = (migCfg.amplience && migCfg.amplience.defaultDeliveryKey) || '';
    ISML.renderTemplate('accelerator/contentMigration', withBmFrame({
        title:               Resource.msg('accelerator.contentmigration.heading', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        platform:            platform,
        dataConnected:       dataConnected,
        connectionSummary:   buildConnectionSummary(platformId),
        defaultDeliveryKey:  defaultDeliveryKey,
        initialStep:         dataConnected ? 2 : 1,
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        testConnectionUrl:   URLUtils.url('Accelerator-TestConnection').toString(),
        listContentUrl:      URLUtils.url('Accelerator-ListAmplienceContent').toString(),
        fetchContentUrl:     URLUtils.url('Accelerator-FetchAmplienceContent').toString(),
        previewLibraryUrl:   URLUtils.url('Accelerator-PreviewAmplienceLibrary').toString(),
        exportContentUrl:    URLUtils.url('Accelerator-ExportAmplienceContent').toString(),
        listMigratedRefsUrl: URLUtils.url('Accelerator-ListMigratedAmplienceRefs').toString(),
        downloadXmlUrl:      URLUtils.url('Accelerator-DownloadContentXml').toString(),
        impexPath:           pageCtx.impexPath,
        impexUrl:            pageCtx.impexUrl,
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString() + '?v=17',
        contentMigrationJsUrl: URLUtils.staticURL('/js/content-migration.js').toString() + '?v=23'
    }));
};
exports.ContentMigration.public = true;

exports.ContentSchemaMigration = function () {
    var platformId = getParam('platform') || 'amplience';
    session.custom.migrationPlatformId = platformId;

    var platform = migrationData.getPlatform(platformId);
    if (!platform || platform.kind !== 'cms') {
        response.redirect(URLUtils.url('Accelerator-Start'));
        return;
    }

    ISML.renderTemplate('accelerator/contentSchemaMigration', withBmFrame({
        title:               Resource.msg('accelerator.contentschemamigration.heading', 'accelerator', null),
        subtitle:            Resource.msg('accelerator.subtitle', 'accelerator', null),
        platform:            platform,
        connectionSummary:   buildConnectionSummary(platformId),
        dashboardUrl:        URLUtils.url('Accelerator-Start').toString(),
        testConnectionUrl:   URLUtils.url('Accelerator-TestConnection').toString(),
        listContentTypesUrl: URLUtils.url('Accelerator-ListAmplienceContentTypes').toString(),
        cssUrl:              URLUtils.staticURL('/css/accelerator-migration.css').toString(),
        contentSchemaMigrationJsUrl: URLUtils.staticURL('/js/content-schema-migration.js').toString() + '?v=1'
    }));
};
exports.ContentSchemaMigration.public = true;

exports.ListAmplienceContentTypes = function () {
    response.setContentType('application/json');
    try {
        var fetcher = require('*/cartridge/scripts/migration/contentMigration/amplienceSchemaFetcher');
        var pageSize = getParam('pageSize') || '100';
        jsonResponse({ ok: true, result: fetcher.listContentTypes(pageSize) });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ListAmplienceContentTypes.public = true;

exports.ListAmplienceContent = function () {
    response.setContentType('application/json');
    try {
        var fetcher = require('*/cartridge/scripts/migration/contentMigration/amplienceContentFetcher');
        var pageSize = getParam('pageSize') || '100';
        jsonResponse({ ok: true, result: fetcher.listContentItems(pageSize) });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ListAmplienceContent.public = true;

function parseAmplienceContentIds() {
    var raw = getParam('contentIds') || '';
    if (!raw) return [];
    var ids = [];
    var i;
    if (raw.charAt(0) === '[') {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            throw new Error('contentIds must be a JSON array or comma-separated list');
        }
        for (i = 0; i < parsed.length; i++) {
            var jsonId = String(parsed[i] || '').trim();
            if (jsonId) ids.push(jsonId);
        }
    } else {
        var parts = raw.split(',');
        for (i = 0; i < parts.length; i++) {
            var id = String(parts[i] || '').trim();
            if (id) ids.push(id);
        }
    }
    if (ids.length > 5000) {
        throw new Error('A maximum of 5000 content items can be processed per request');
    }
    return ids;
}

function getAmplienceAppendFile(extension) {
    var fileName = getParam('appendFile') || '';
    if (!fileName) return '';
    var expected = extension === 'json'
        ? /^[a-zA-Z0-9_\-]+\.json$/
        : /^[a-zA-Z0-9_\-]+\.xml$/;
    if (!expected.test(fileName)) {
        throw new Error('Invalid append file name');
    }
    return fileName;
}

exports.PreviewAmplienceLibrary = function () {
    response.setContentType('application/json');
    try {
        var contentIds = parseAmplienceContentIds();
        if (!contentIds.length) {
            jsonResponse({ ok: false, error: 'At least one content item is required' });
            return;
        }
        var selection = {};
        var selectionRaw = getParam('selection') || '';
        if (selectionRaw) {
            try { selection = JSON.parse(selectionRaw); } catch (pe) { selection = {}; }
        }
        var runner = require('*/cartridge/scripts/migration/contentMigration/contentMigrationRunner');
        jsonResponse(runner.previewByContentIds(contentIds, selection, {
            appendFile:     getAmplienceAppendFile('json'),
            totalRequested: parseInt(getParam('totalRequested') || String(contentIds.length), 10)
        }));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.PreviewAmplienceLibrary.public = true;

exports.FetchAmplienceContent = function () {
    response.setContentType('application/json');
    var deliveryKey = getParam('deliveryKey');
    var contentId   = getParam('contentId');
    if (!deliveryKey && !contentId) {
        jsonResponse({ ok: false, error: 'deliveryKey or contentId is required' });
        return;
    }
    try {
        var fetcher     = require('*/cartridge/scripts/migration/contentMigration/amplienceContentFetcher');
        var transformer = require('*/cartridge/scripts/migration/contentMigration/amplienceContentTransformer');
        // Prefer Management API by content id (works without published delivery key).
        var fetched     = contentId
            ? fetcher.fetchByContentId(contentId)
            : fetcher.fetchByDeliveryKey(deliveryKey);
        var widget      = transformer.transformFetchedContent(fetched);
        jsonResponse({
            ok:      true,
            fetched: {
                deliveryKey:    fetched.deliveryKey || '',
                contentId:      fetched.contentId || '',
                hasDeliveryKey: !!fetched.hasDeliveryKey,
                hubName:        fetched.hubName,
                cdnUrl:         fetched.cdnUrl || '',
                source:         fetched.source || ''
            },
            widget: widget
        });
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.FetchAmplienceContent.public = true;

exports.ExportAmplienceContent = function () {
    response.setContentType('application/json');
    var deliveryKey = getParam('deliveryKey');
    var contentId   = getParam('contentId');
    try {
        var contentIds = parseAmplienceContentIds();
        var appendFile = getAmplienceAppendFile('xml');
        var finalizeRaw = getParam('finalize');
        // Batched export leaves the library open until the last chunk (finalize=1).
        var finalize = (!finalizeRaw && finalizeRaw !== '0' && finalizeRaw !== 'false')
            ? true
            : (finalizeRaw === '1' || finalizeRaw === 'true');
        if (!deliveryKey && !contentId && !contentIds.length && !(appendFile && finalize)) {
            jsonResponse({ ok: false, error: 'deliveryKey, contentId, or contentIds is required' });
            return;
        }
        var runner = require('*/cartridge/scripts/migration/contentMigration/contentMigrationRunner');
        var exportOpts = { appendFile: appendFile, finalize: finalize };
        // Prefer content id so unpublished / keyless items still export to library XML.
        var result = contentIds.length
            ? runner.exportByContentIds(contentIds, null, exportOpts)
            : (contentId
                ? runner.exportByContentIds(contentId, null, exportOpts)
                : (appendFile && finalize
                    ? runner.exportByContentIds([], null, exportOpts)
                    : runner.exportByDeliveryKeys(deliveryKey)));
        jsonResponse(result);
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ExportAmplienceContent.public = true;

exports.ListMigratedAmplienceRefs = function () {
    response.setContentType('application/json');
    try {
        var syncRunner = require('*/cartridge/scripts/migration/contentMigration/contentSyncRunner');
        jsonResponse(syncRunner.listMigratedRefs(getParam('folderId') || 'amplience'));
    } catch (e) {
        jsonResponse({ ok: false, error: e.message || String(e) });
    }
};
exports.ListMigratedAmplienceRefs.public = true;

/**
 * GET: fileName=<name> — streams content library XML from IMPEX as a download.
 */
exports.DownloadContentXml = function () {
    var fileName = getParam('fileName') || '';
    if (!fileName || !/^[a-zA-Z0-9_\-]+\.(xml|json)$/.test(fileName)) {
        response.setContentType('text/plain');
        response.writer.print('Invalid or missing fileName parameter.');
        return;
    }
    var File       = require('dw/io/File');
    var FileReader = require('dw/io/FileReader');
    var sep        = File.SEPARATOR;
    var file       = new File(File.IMPEX + sep + 'src' + sep + 'migration' + sep + 'content' + sep + fileName);
    if (!file.exists()) {
        response.setContentType('text/plain');
        response.writer.print('File not found: ' + fileName);
        return;
    }
    response.setContentType(/\.json$/.test(fileName) ? 'application/json' : 'application/xml');
    response.addHttpHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    var reader = new FileReader(file, 'UTF-8');
    try {
        var line;
        while ((line = reader.readLine()) !== null) {
            response.writer.println(line);
        }
    } finally {
        reader.close();
    }
};
exports.DownloadContentXml.public = true;

// ─── LINK security: wrap all public endpoints with BM auth + CSRF ────────────
(function applyRequestGuards() {
    var requestGuard = require('*/cartridge/scripts/accelerator/requestGuard');
    var PAGE_ENDPOINTS = {
        Start: true,
        DataWizard: true,
        DataWizardContinue: true,
        DataWizardSelectType: true,
        DataMigrationLogout: true,
        DataMigrationDashboard: true,
        DataMigrationFlow: true,
        OrderMigration: true,
        CustomerMigration: true,
        ShippingMethodMigration: true,
        InventoryMigration: true,
        PricebookMigration: true,
        TaxMigration: true,
        StoreMigration: true,
        ProductWizard: true,
        ProductMigration: true,
        CategoryMigration: true,
        ContentMigration: true,
        ContentSchemaMigration: true,
        DownloadMigrationFile: true,
        DownloadProductXml: true,
        DownloadContentXml: true
    };
    var names = Object.keys(exports);
    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var fn = exports[name];
        if (typeof fn === 'function' && fn.public) {
            exports[name] = requestGuard.wrap(fn, { page: !!PAGE_ENDPOINTS[name] });
        }
    }
}());

