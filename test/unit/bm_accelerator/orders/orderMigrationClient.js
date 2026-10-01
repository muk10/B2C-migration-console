'use strict';

/* eslint-env mocha */

var path = require('path');
var assert = require('chai').assert;

var clientPath = path.resolve(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/client/default/js/order-migration.js'
);

/**
 * @param {Object} [attributes] - data attributes of the fake element
 * @returns {Object} minimal DOM element stub
 */
function element(attributes) {
    return {
        attributes: attributes || {},
        className: '',
        disabled: false,
        style: {},
        textContent: '',
        value: '',
        handlers: {},
        getAttribute: function (name) { return this.attributes[name] || ''; },
        addEventListener: function (name, handler) { this.handlers[name] = handler; },
        trigger: function (name) {
            if (this.handlers[name]) this.handlers[name]({ preventDefault: function () {} });
        }
    };
}

describe('order migration client state', function () {
    var previousWindow;
    var previousDocument;
    var previousXhr;

    beforeEach(function () {
        previousWindow = global.window;
        previousDocument = global.document;
        previousXhr = global.XMLHttpRequest;
    });

    afterEach(function () {
        delete require.cache[clientPath];
        global.window = previousWindow;
        global.document = previousDocument;
        global.XMLHttpRequest = previousXhr;
    });

    it('resets a completed export when filters change and lets the next export start', function () {
        var root = element({
            'data-count-url': '/count',
            'data-export-url': '/export',
            'data-wizard-entry-url': '/wizard'
        });
        var elements = {
            'acc-ord-root': root,
            'acc-ord-years': element(),
            'acc-ord-order-state': element(),
            'acc-ord-payment-state': element(),
            'acc-ord-max-count': element(),
            'acc-ord-count-btn': element(),
            'acc-ord-count-value': element(),
            'acc-ord-count-export': element(),
            'full-start-btn': element(),
            'full-phase-list': element(),
            'full-move-overall': element(),
            'full-phase-build': element(),
            'full-status-build': element(),
            'full-detail-build': element(),
            'full-bar-build': element(),
            'full-phase-import': element(),
            'full-status-import': element(),
            'full-detail-import': element(),
            'full-bar-import': element()
        };
        elements['acc-ord-years'].value = '1';

        var countCalls = 0;
        var exportCalls = 0;
        /** Fake XMLHttpRequest answering count and export calls synchronously. */
        function FakeXhr() {}
        FakeXhr.prototype.open = function (method, url) { this.url = url; };
        FakeXhr.prototype.setRequestHeader = function () {};
        FakeXhr.prototype.send = function () {
            var response;
            if (this.url === '/count') {
                countCalls++;
                response = { ok: true, total: countCalls === 1 ? 2 : 10000, exportCount: countCalls === 1 ? 2 : 10000 };
            } else {
                exportCalls++;
                response = {
                    ok: true,
                    done: true,
                    files: ['order-test-' + exportCalls + '-p0001.xml'],
                    fileName: 'order-test-' + exportCalls + '-p0001.xml',
                    report: { ordersValidated: countCalls === 1 ? 2 : 10000, ordersFailed: 0 }
                };
            }
            this.readyState = 4;
            this.responseText = JSON.stringify(response);
            this.onreadystatechange();
        };

        global.window = { location: { href: '' } };
        global.document = {
            readyState: 'complete',
            getElementById: function (id) { return elements[id] || null; }
        };
        global.XMLHttpRequest = FakeXhr;

        delete require.cache[clientPath];
        require(clientPath);

        elements['acc-ord-count-btn'].trigger('click');
        elements['full-start-btn'].trigger('click');
        assert.equal(elements['full-start-btn'].textContent, 'Finish');
        assert.equal(exportCalls, 1);

        elements['acc-ord-years'].value = '3';
        elements['acc-ord-years'].trigger('change');
        assert.equal(elements['full-start-btn'].textContent, 'Start Migration (Build XML)');
        assert.isTrue(elements['full-start-btn'].disabled);
        assert.equal(elements['full-phase-list'].style.display, 'none');

        elements['acc-ord-count-btn'].trigger('click');
        assert.equal(elements['acc-ord-count-value'].textContent, '10,000 orders match your filters');
        assert.isFalse(elements['full-start-btn'].disabled);

        elements['full-start-btn'].trigger('click');
        assert.equal(exportCalls, 2);
        assert.equal(elements['full-start-btn'].textContent, 'Finish');

        elements['full-start-btn'].trigger('click');
        assert.equal(global.window.location.href, '/wizard');
    });

    it('keeps requesting batches with the returned state until the export is done', function () {
        var elements = {};
        ['acc-ord-years', 'acc-ord-order-state', 'acc-ord-payment-state', 'acc-ord-max-count', 'acc-ord-count-btn',
            'acc-ord-count-value', 'acc-ord-count-export', 'full-start-btn', 'full-phase-list', 'full-move-overall',
            'full-phase-build', 'full-status-build', 'full-detail-build', 'full-bar-build',
            'full-phase-import', 'full-status-import', 'full-detail-import', 'full-bar-import'
        ].forEach(function (id) { elements[id] = element(); });
        elements['acc-ord-root'] = element({ 'data-count-url': '/count', 'data-export-url': '/export' });
        elements['acc-ord-years'].value = 'all';

        var exportBodies = [];
        var replies = [
            { ok: true, done: false, total: 2500, processed: 1000, files: ['o-p0001.xml'], state: { stem: 'order-20260929-v001', processed: 1000 } },
            { ok: true, done: false, total: 2500, processed: 2000, files: ['o-p0001.xml'], state: { stem: 'order-20260929-v001', processed: 2000 } },
            { ok: true, done: true, total: 2500, processed: 2500, files: ['o-p0001.xml', 'o-p0002.xml'], report: { ordersValidated: 2500, ordersFailed: 0 } }
        ];
        /** Fake XMLHttpRequest answering count and export calls synchronously. */
        function FakeXhr() {}
        FakeXhr.prototype.open = function (method, url) { this.url = url; };
        FakeXhr.prototype.setRequestHeader = function () {};
        FakeXhr.prototype.send = function (body) {
            var response = { ok: true, total: 2500, exportCount: 2500 };
            if (this.url === '/export') {
                exportBodies.push(body);
                response = replies[exportBodies.length - 1];
            }
            this.readyState = 4;
            this.responseText = JSON.stringify(response);
            this.onreadystatechange();
        };

        global.window = { location: { href: '' } };
        global.document = { readyState: 'complete', getElementById: function (id) { return elements[id] || null; } };
        global.XMLHttpRequest = FakeXhr;
        delete require.cache[clientPath];
        require(clientPath);

        elements['acc-ord-count-btn'].trigger('click');
        elements['full-start-btn'].trigger('click');

        assert.lengthOf(exportBodies, 3);
        assert.notInclude(exportBodies[0], 'state=');
        assert.include(decodeURIComponent(exportBodies[1]), '"processed":1000');
        assert.include(decodeURIComponent(exportBodies[2]), '"processed":2000');
        assert.include(elements['full-detail-build'].textContent, '2 file(s): o-p0001.xml, o-p0002.xml');
        assert.equal(elements['full-start-btn'].textContent, 'Finish');
    });

    it('stops instead of looping when a reply is not done but has no state', function () {
        var elements = {};
        ['acc-ord-years', 'acc-ord-count-btn', 'acc-ord-count-value', 'full-start-btn', 'full-phase-list',
            'full-phase-build', 'full-status-build', 'full-detail-build', 'full-bar-build'
        ].forEach(function (id) { elements[id] = element(); });
        elements['acc-ord-root'] = element({ 'data-count-url': '/count', 'data-export-url': '/export' });
        var exportCalls = 0;
        /** Fake XMLHttpRequest whose export reply lacks done and state. */
        function FakeXhr() {}
        FakeXhr.prototype.open = function (method, url) { this.url = url; };
        FakeXhr.prototype.setRequestHeader = function () {};
        FakeXhr.prototype.send = function () {
            var response = this.url === '/export'
                ? (exportCalls++, { ok: true, report: { ordersValidated: 5, ordersFailed: 0 } })
                : { ok: true, total: 5, exportCount: 5 };
            this.readyState = 4;
            this.responseText = JSON.stringify(response);
            this.onreadystatechange();
        };
        global.window = { location: { href: '' } };
        global.document = { readyState: 'complete', getElementById: function (id) { return elements[id] || null; } };
        global.XMLHttpRequest = FakeXhr;
        delete require.cache[clientPath];
        require(clientPath);

        elements['acc-ord-count-btn'].trigger('click');
        elements['full-start-btn'].trigger('click');
        assert.equal(exportCalls, 1);
        assert.equal(elements['full-start-btn'].textContent, 'Finish');
    });
});
