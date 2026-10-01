'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path       = require('path');

var connectorPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/orders/connectors/ctpOrderConnector.js'
);

describe('ctpOrderConnector', function () {
    var httpCalls;
    var connector;

    beforeEach(function () {
        httpCalls = [];

        var httpStub = {
            get: function (url, headers) {
                httpCalls.push({ method: 'GET', url: url, headers: headers });
                if (url.indexOf('/orders') >= 0) {
                    return {
                        status: 200,
                        data: {
                            results: [{ id: 'order-1', orderNumber: '1001' }],
                            total:   1
                        }
                    };
                }
                return { status: 404, data: {} };
            },
            post: function (url, headers, body) {
                httpCalls.push({ method: 'POST', url: url, body: body });
                return { status: 200, data: { access_token: 'test-token' } };
            }
        };

        var configStub = {
            ctp: {
                projectKey:   'test-project',
                clientId:     'client-id',
                clientSecret: 'client-secret',
                authUrl:      'https://auth.example.com',
                apiUrl:       'https://api.example.com'
            }
        };

        connector = proxyquire(connectorPath, {
            '*/cartridge/scripts/migration/core/http': httpStub,
            '*/cartridge/scripts/migration/configAccessor': configStub,
            'dw/crypto/Encoding': {
                toBase64: function () { return 'encoded'; }
            },
            'dw/util/Bytes': function Bytes(str) { this.str = str; }
        });
    });

    it('should authenticate using client credentials', function () {
        var token = connector.authenticate();
        assert.equal(token, 'test-token');
        assert.equal(httpCalls[0].method, 'POST');
        assert.ok(httpCalls[0].url.indexOf('/oauth/token') >= 0);
        assert.ok(httpCalls[0].body.indexOf('grant_type=client_credentials') >= 0);
    });

    it('should fetch orders by date range with pagination', function () {
        var orders = connector.fetchOrdersByDateRange({ years: 1 });
        assert.equal(orders.length, 1);
        assert.equal(orders[0].orderNumber, '1001');

        var orderCall = httpCalls.filter(function (c) { return c.method === 'GET'; })[0];
        assert.ok(orderCall.url.indexOf('/orders') >= 0);
        assert.ok(orderCall.url.indexOf('where=') >= 0);
        assert.ok(orderCall.headers.Authorization.indexOf('Bearer test-token') >= 0);
    });

    it('should respect maxCount limit', function () {
        var httpStub = {
            get: function () {
                return {
                    status: 200,
                    data: {
                        results: [
                            { id: '1', orderNumber: '1' },
                            { id: '2', orderNumber: '2' },
                            { id: '3', orderNumber: '3' }
                        ],
                        total: 3
                    }
                };
            },
            post: function () {
                return { status: 200, data: { access_token: 'token' } };
            }
        };

        var limited = proxyquire(connectorPath, {
            '*/cartridge/scripts/migration/core/http': httpStub,
            '*/cartridge/scripts/migration/configAccessor': { ctp: { projectKey: 'p', clientId: 'c', clientSecret: 's', authUrl: 'https://a', apiUrl: 'https://api' } },
            'dw/crypto/Encoding': { toBase64: function () { return 'x'; } },
            'dw/util/Bytes': function Bytes() {}
        });

        var orders = limited.fetchOrdersByDateRange({ years: 2, maxCount: 2 });
        assert.equal(orders.length, 2);
    });

    it('should retry on server errors', function () {
        var attempts = 0;
        var httpStub = {
            get: function () {
                attempts++;
                if (attempts < 2) {
                    return { status: 503, data: {} };
                }
                return {
                    status: 200,
                    data: { results: [{ id: '1' }], total: 1 }
                };
            },
            post: function () {
                return { status: 200, data: { access_token: 'token' } };
            }
        };

        var retryConnector = proxyquire(connectorPath, {
            '*/cartridge/scripts/migration/core/http': httpStub,
            '*/cartridge/scripts/migration/configAccessor': { ctp: { projectKey: 'p', clientId: 'c', clientSecret: 's', authUrl: 'https://a', apiUrl: 'https://api' } },
            'dw/crypto/Encoding': { toBase64: function () { return 'x'; } },
            'dw/util/Bytes': function Bytes() {}
        });

        var orders = retryConnector.fetchOrdersByDateRange({ years: 1 });
        assert.equal(orders.length, 1);
        assert.ok(attempts >= 2);
    });

    describe('date range', function () {
        /**
         * @returns {string} URL of the first orders request
         */
        function ordersUrl() {
            return httpCalls.filter(function (c) { return c.method === 'GET'; })[0].url;
        }

        it('filters on createdAt for 1, 2 and 3 years', function () {
            connector.countOrders({ years: 3 });
            assert.include(decodeURIComponent(ordersUrl()), 'createdAt >= "');
        });

        it('exports every order for "all": no createdAt filter and no empty where', function () {
            connector.countOrders({ years: 'all' });
            assert.notInclude(ordersUrl(), 'where=');

            httpCalls = [];
            connector.fetchOrdersByDateRange({ years: 0 });
            assert.notInclude(ordersUrl(), 'where=');
        });

        it('keeps state filters when exporting all orders', function () {
            connector.countOrders({ years: 'all', orderState: 'Complete' });
            var where = decodeURIComponent(ordersUrl().split('where=')[1].split('&')[0]);
            assert.include(where, 'orderState = "Complete"');
            assert.notInclude(where, 'createdAt');
        });

        it('parses the date range', function () {
            assert.equal(connector.parseYears('all'), 0);
            assert.equal(connector.parseYears(0), 0);
            assert.equal(connector.parseYears('2'), 2);
            assert.equal(connector.parseYears(undefined), 1);
            assert.equal(connector.dateYearsAgo(0), '');
            assert.throws(function () { connector.parseYears('5'); }, /1, 2 or 3 years, or all/);
        });
    });

    describe('cursor paging and exact counts', function () {
        /**
         * Connector over a synthetic order set that behaves like commercetools:
         * total is capped at 10,000 whenever a where predicate is set.
         * @param {number} n - number of orders, one per minute from 2023-01-01
         * @returns {Object} { connector, calls }
         */
        function loadSynthetic(n) {
            var times = [];
            var i;
            for (i = 0; i < n; i++) times.push(Date.UTC(2023, 0, 1) + i * 60000);
            var calls = [];
            var stub = {
                get: function (url) {
                    calls.push(url);
                    var q = decodeURIComponent(url);
                    var ge = /createdAt >= "([^"]+)"/.exec(q);
                    var lt = /createdAt < "([^"]+)"/.exec(q);
                    var match = times.filter(function (t) {
                        return (!ge || t >= Date.parse(ge[1])) && (!lt || t < Date.parse(lt[1]));
                    });
                    var total = q.indexOf('where=') >= 0 ? Math.min(match.length, 10000) : match.length;
                    return { status: 200, data: {
                        total:   total,
                        results: match.slice(0, 1).map(function (t) { return { id: 'x', createdAt: new Date(t).toISOString() }; })
                    } };
                },
                post: function () { return { status: 200, data: { access_token: 't' } }; }
            };
            return {
                calls: calls,
                connector: proxyquire(connectorPath, {
                    '*/cartridge/scripts/migration/core/http': stub,
                    '*/cartridge/scripts/migration/configAccessor': { ctp: { projectKey: 'p', clientId: 'c', clientSecret: 's', authUrl: 'https://a', apiUrl: 'https://api' } },
                    'dw/crypto/Encoding': { toBase64: function () { return 'x'; } },
                    'dw/util/Bytes': function Bytes() {}
                })
            };
        }

        it('continues after the last order by createdAt then id, without offset', function () {
            connector.fetchOrdersPage('t', { after: { createdAt: '2024-05-01T10:00:00.000Z', id: 'abc' }, offset: 9999, limit: 20, withTotal: false });
            var url = decodeURIComponent(httpCalls[httpCalls.length - 1].url);
            assert.include(url, '(createdAt > "2024-05-01T10:00:00.000Z" or (createdAt = "2024-05-01T10:00:00.000Z" and id > "abc"))');
            assert.include(url, 'offset=0');
            assert.include(url, 'sort=createdAt asc&sort=id asc');
            assert.include(url, 'withTotal=false');
        });

        it('uses pages of 20 orders to stay under the script string quota', function () {
            assert.equal(connector.DEFAULT_LIMIT, 20);
        });

        it('counts exactly beyond the 10,000 cap by splitting the date range', function () {
            var env = loadSynthetic(25000);
            // a filtered count would report 10,000; the split count is exact
            assert.equal(env.connector.countOrders({ years: 'all', orderState: 'Complete' }).total, 25000);
            assert.isBelow(env.calls.length, 40);
        });

        it('trusts the unfiltered total, which commercetools does not cap', function () {
            var env = loadSynthetic(25000);
            assert.equal(env.connector.countOrders({ years: 'all' }).total, 25000);
            assert.lengthOf(env.calls, 1);
        });

        it('keeps the single request when the total is below the cap', function () {
            var env = loadSynthetic(500);
            assert.equal(env.connector.countOrders({ years: 'all', orderState: 'Open' }).total, 500);
            assert.lengthOf(env.calls, 1);
        });
    });
});

describe('ctpOrderConnector.addCustomerNumbers', function () {
    /**
     * @param {Object} reply - { status, data } for the customers request
     * @returns {Object} { connector, calls }
     */
    function loadWith(reply) {
        var calls = [];
        var connector = proxyquire(connectorPath, {
            '*/cartridge/scripts/migration/core/http': {
                get: function (url) { calls.push(url); return reply; },
                post: function () { return { status: 200, data: { access_token: 't' } }; }
            },
            '*/cartridge/scripts/migration/configAccessor': {
                ctp: { projectKey: 'p', authUrl: 'https://auth', apiUrl: 'https://api' }
            },
            'dw/crypto/Encoding': { toBase64: function () { return 'x'; } },
            'dw/util/Bytes': function Bytes() {}
        });
        return { connector: connector, calls: calls };
    }

    it('reads the customers of a page in one request and adds their customerNumber', function () {
        var env = loadWith({ status: 200, data: { results: [
            { id: 'c1', customerNumber: 'N-1' },
            { id: 'c2' }
        ] } });
        var orders = [{ customerId: 'c1' }, { customerId: 'c2' }, { customerId: 'c1' }, {}];
        env.connector.addCustomerNumbers('t', orders);

        assert.lengthOf(env.calls, 1);
        var where = decodeURIComponent(env.calls[0].split('where=')[1]);
        assert.equal(where, 'id in ("c1", "c2")');
        assert.include(env.calls[0], '/p/customers?limit=2');
        assert.equal(orders[0].customerNumber, 'N-1');
        assert.equal(orders[2].customerNumber, 'N-1');
        assert.isUndefined(orders[1].customerNumber);
        assert.isUndefined(orders[3].customerNumber);
    });

    it('makes no request for a page of guest orders', function () {
        var env = loadWith({ status: 200, data: { results: [] } });
        env.connector.addCustomerNumbers('t', [{}, { customerEmail: 'a@b.c' }]);
        assert.lengthOf(env.calls, 0);
    });

    it('explains a missing view_customers scope', function () {
        var env = loadWith({ status: 403, data: {} });
        assert.throws(function () {
            env.connector.addCustomerNumbers('t', [{ customerId: 'c1' }]);
        }, /view_customers/);
    });
});
