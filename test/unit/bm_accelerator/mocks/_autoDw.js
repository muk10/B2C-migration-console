'use strict';

/**
 * Permissive auto-stub for any dw/* API module that has no dedicated mock under
 * test/unit/bm_accelerator/mocks/dw/. Its only job is to let cartridge modules
 * *load* under Node/Mocha — it does NOT emulate real B2C behaviour.
 *
 * Every property access, call, and `new` returns another chainable stub, so
 * load-time patterns like `require('dw/system/Logger').getLogger('a', 'b')` or
 * `new (require('dw/util/HashMap'))()` resolve without throwing. A test that needs
 * a module to actually *do* something must add an explicit mock (which wins over
 * this fallback in cartridgeLoader) — otherwise calls quietly no-op.
 */
function makeStub() {
    var fn = function () { return stub; };
    var stub = new Proxy(fn, {
        get: function (target, prop) {
            if (prop === 'default') return stub;
            if (prop === '__esModule') return false;
            // Keep primitive coercion from recursing into more proxies.
            if (prop === 'toString' || prop === 'valueOf' || prop === Symbol.toPrimitive) {
                return function () { return ''; };
            }
            if (prop === Symbol.iterator) {
                return function () { return [][Symbol.iterator](); };
            }
            return makeStub();
        },
        apply:     function () { return makeStub(); },
        construct: function () { return makeStub(); }
    });
    return stub;
}

module.exports = makeStub();
