'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path       = require('path');

var runnerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/fullMigrationRunner.js'
);

/**
 * @param {number} n - number of orders
 * @returns {Object[]} raw orders sorted by createdAt, id; every 3 orders share a createdAt
 */
function makeOrders(n) {
    var list = [];
    var i;
    for (i = 0; i < n; i++) {
        var id = 'id-' + String(100000 + i);
        list.push({ id: id, orderNumber: 'o' + i, createdAt: new Date(Date.UTC(2024, 0, 1) + Math.floor(i / 3) * 1000).toISOString() });
    }
    return list;
}

/**
 * Load the runner against an in-memory commercetools-like source and in-memory IMPEX files.
 * @param {Object[]} orders - source orders
 * @param {Object} [opts] - { existingFiles: [names], badNumbers: {orderNumber: true} }
 * @returns {Object} { runner, files, fetches }
 */
function load(orders, opts) {
    var o = opts || {};
    var files = {};
    var fetches = [];
    var enriched = [];

    /**
     * @param {Object} dir - parent directory stub
     * @param {string} name - file name
     */
    function File(dir, name) { this.name = name; }
    /**
     * @param {Object} file - File stub
     * @param {string} enc - encoding
     * @param {boolean} append - append instead of overwrite
     */
    function FileWriter(file, enc, append) {
        this.name = file.name;
        if (!append || files[this.name] === undefined) files[this.name] = '';
    }
    FileWriter.prototype.write = function (s) { files[this.name] += s; };
    FileWriter.prototype.close = function () {};

    var connector = {
        DEFAULT_LIMIT:   20,
        SUPPORTS_CURSOR: true,
        parseYears:      function (v) { return v === 'all' ? 0 : 1; },
        dateYearsAgo:    function () { return ''; },
        authenticate:    function () { return 't'; },
        countOrders:     function (f) { return { exportCount: f.maxCount && f.maxCount < orders.length ? f.maxCount : orders.length }; },
        fetchOrdersPage: function (token, p) {
            fetches.push(p);
            var start = 0;
            if (p.after) {
                while (start < orders.length && (orders[start].createdAt < p.after.createdAt
                    || (orders[start].createdAt === p.after.createdAt && orders[start].id <= p.after.id))) start++;
            }
            return { results: orders.slice(start, start + p.limit) };
        }
    };

    var runner = proxyquire(runnerPath, {
        'dw/io/File':       File,
        'dw/io/FileWriter': FileWriter,
        '*/cartridge/scripts/migration/core/dataSourceRegistry': {
            getFetcher: function () { return connector; },
            getMapper:  function () {
                return { mapOrder: function (r) { return { orderNumber: r.orderNumber, customerNo: r.customerNumber }; } };
            }
        },
        '*/cartridge/scripts/migration/orders/validators/orderValidator': {
            validateOrder: function (c) {
                return (o.badNumbers || {})[c.orderNumber] ? { valid: false, errors: ['bad'] } : { valid: true };
            }
        },
        '*/cartridge/scripts/migration/orders/generators/sfccOrderXmlGenerator': {
            buildHeader:              function () { return '<orders>\n'; },
            buildFooter:              function () { return '</orders>\n'; },
            generateOrderInnerXml:    function (c) {
                return '<order no="' + c.orderNumber + '"' + (c.customerNo ? ' customer="' + c.customerNo + '"' : '') + '/>';
            },
            assertValidOrderDocument: function () {}
        },
        '*/cartridge/scripts/migration/core/migrationFileResolver': {
            getRunDate:      function () { return '20260929'; },
            localFileExists: function (p) { return (o.existingFiles || []).indexOf(p.split('/').pop()) >= 0; }
        },
        '*/cartridge/scripts/migration/core/migrationPaths': {
            getRelativePath:  function () { return 'src/migration/order'; },
            buildXmlFileName: function (m, d, v) { return 'order-' + d + '-v' + ('00' + v).slice(-3) + '.xml'; }
        },
        '*/cartridge/scripts/migration/orders/generators/impexGenerator': {
            ensureDir: function () { return {}; }
        },
        '*/cartridge/scripts/migration/orders/productIdResolver': {
            createResolver: function () {
                // one line item without an SFCC product for every order number ending in 7
                return { resolveOrder: function (c) { return /7$/.test(c.orderNumber) ? 1 : 0; } };
            }
        }
    });
    if (o.customerNumbers) {
        connector.addCustomerNumbers = function (token, page) {
            var rows = page;
            enriched.push(rows.length);
            for (var i = 0; i < rows.length; i++) rows[i].customerNumber = 'N-' + rows[i].id;
        };
    }
    return { runner: runner, files: files, fetches: fetches, enriched: enriched };
}

/**
 * Call runChunk until done, passing the state through JSON like the page does.
 * @param {Object} runner - loaded runner
 * @param {Object} options - export filters
 * @returns {Object} { last, requests }
 */
function runAll(runner, options) {
    var result = runner.runChunk(options, null);
    var requests = 1;
    while (result.ok && !result.done && requests < 1000) {
        result = runner.runChunk(options, JSON.parse(JSON.stringify(result.state)));
        requests++;
    }
    return { last: result, requests: requests };
}

/**
 * @param {string} xml - part file content
 * @returns {string[]} order numbers in the file
 */
function numbersIn(xml) {
    return (xml.match(/no="[^"]+"/g) || []).map(function (m) { return m.slice(4, -1); });
}

describe('order fullMigrationRunner (batched export)', function () {
    it('exports 12,345 orders in 1,000-order requests, starting a new file when the size quota is hit', function () {
        var orders = makeOrders(12345);
        var env = load(orders);
        var quota = 100000;
        var run = runAll(env.runner, { years: 'all', maxFileChars: quota });

        assert.isTrue(run.last.ok);
        assert.isTrue(run.last.done);
        assert.equal(run.requests, 13);
        assert.isAbove(run.last.files.length, 1);
        assert.equal(run.last.ordersValidated, 12345);

        var all = [];
        run.last.files.forEach(function (name, idx) {
            var xml = env.files[name];
            assert.equal(name, 'order-20260929-v001-p000' + (idx + 1) + '.xml');
            assert.isAtMost(xml.length, quota, name + ' stays within the quota');
            assert.equal(xml.indexOf('<orders>\n'), 0, name + ' starts with the header');
            assert.equal(xml.split('<orders>').length - 1, 1, name + ' has one header');
            assert.equal(xml.split('</orders>').length - 1, 1, name + ' has one footer');
            assert.isTrue(/<\/orders>\n$/.test(xml), name + ' ends with the footer');
            if (idx < run.last.files.length - 1) {
                assert.isAbove(xml.length, quota - 40, name + ' is filled up to the quota before rolling over');
            }
            all = all.concat(numbersIn(xml));
        });
        assert.deepEqual(all, orders.map(function (x) { return x.orderNumber; }), 'every order once, in order');
    });

    it('writes one file when everything fits the default 190 MB quota', function () {
        var env = load(makeOrders(12345));
        var run = runAll(env.runner, { years: 'all' });
        assert.deepEqual(run.last.files, ['order-20260929-v001-p0001.xml']);
        assert.equal(env.runner.MAX_FILE_CHARS, 190 * 1024 * 1024);
    });

    it('still writes an order larger than the quota, in a file of its own', function () {
        var env = load(makeOrders(3));
        var run = runAll(env.runner, { years: 'all', maxFileChars: 10 });
        assert.lengthOf(run.last.files, 3);
        run.last.files.forEach(function (name) { assert.lengthOf(numbersIn(env.files[name]), 1); });
    });

    it('pages by cursor, never by offset past the first page', function () {
        var env = load(makeOrders(250));
        runAll(env.runner, { years: 'all' });
        assert.isNull(env.fetches[0].after);
        env.fetches.slice(1).forEach(function (p) { assert.isObject(p.after); });
        env.fetches.forEach(function (p) { assert.isFalse(p.withTotal); });
    });

    it('stops at the maximum order count', function () {
        var env = load(makeOrders(3000));
        var run = runAll(env.runner, { years: 'all', maxCount: 2500 });
        assert.equal(run.last.ordersProcessed, 2500);
        assert.lengthOf(numbersIn(env.files['order-20260929-v001-p0001.xml']), 2500);
        assert.equal(run.last.total, 2500);
    });

    it('counts invalid orders as failed without writing them', function () {
        var env = load(makeOrders(50), { badNumbers: { o3: true, o40: true } });
        var run = runAll(env.runner, { years: 'all' });
        assert.equal(run.last.ordersFailed, 2);
        assert.equal(run.last.ordersValidated, 48);
        assert.notInclude(env.files['order-20260929-v001-p0001.xml'], 'no="o3"');
    });

    it('uses the next free version when a split run already exists today', function () {
        var env = load(makeOrders(5), { existingFiles: ['order-20260929-v001-p0001.xml'] });
        var run = runAll(env.runner, { years: 'all' });
        assert.deepEqual(run.last.files, ['order-20260929-v002-p0001.xml']);
    });

    it('adds customer numbers once per page before the orders are mapped', function () {
        var env = load(makeOrders(45), { customerNumbers: true });
        runAll(env.runner, { years: 'all' });
        assert.deepEqual(env.enriched, [20, 20, 5]);
        assert.include(env.files['order-20260929-v001-p0001.xml'], 'no="o0" customer="N-id-100000"');
    });

    it('counts line items with no SFCC product across requests', function () {
        var env = load(makeOrders(2500));
        var run = runAll(env.runner, { years: 'all' });
        // order numbers o7, o17, ... o2497: 250 orders
        assert.equal(run.last.productsNotFound, 250);
        assert.equal(run.last.ordersValidated, 2500);
    });

    it('rejects a state whose file name was tampered with', function () {
        var env = load(makeOrders(5));
        var result = env.runner.runChunk({ years: 'all' }, { stem: '../../x', part: 1 });
        assert.isFalse(result.ok);
    });
});
