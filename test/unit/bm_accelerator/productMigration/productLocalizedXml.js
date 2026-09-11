'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path = require('path');

var transformerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/productMigration/productTransformer.js'
);
var xmlBuilderPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/productMigration/productXmlBuilder.js'
);

function loadTransformer(sessionMap) {
    sessionMap = sessionMap || {};
    var curated = {
        ID: ['id'],
        name: ['name'],
        shortDescription: ['description'],
        longDescription: [],
        pageURL: ['slug'],
        pageTitle: ['metaTitle'],
        pageDescription: ['metaDescription'],
        pageKeywords: ['metaKeywords'],
        manufacturerSKU: ['sku'],
        taxClassID: ['taxCategory'],
        brand: [],
        manufacturerName: [],
        EAN: [],
        UPC: [],
        onlineFlag: ['masterData.published'],
        minOrderQuantity: [],
        stepQuantity: [],
        unitQuantity: [],
        unit: [],
        unitMeasure: []
    };
    return proxyquire(transformerPath, {
        '*/cartridge/scripts/migration/core/systemFieldResolver': {
            getSourceKeys: function (platform, task, sfccField) {
                var out = [];
                var keys = Object.keys(sessionMap);
                var i;
                for (i = 0; i < keys.length; i++) {
                    if (sessionMap[keys[i]] === sfccField) out.push(keys[i]);
                }
                return out.concat(curated[sfccField] || []);
            },
            resolve: function (opts) {
                var keys = this.getSourceKeys('ct', 'Product', opts.sfccField);
                var i;
                for (i = 0; i < keys.length; i++) {
                    var v = opts.getSourceValue(keys[i]);
                    if (v) return v;
                }
                return '';
            }
        }
    });
}

function loadXmlBuilder(sessionResolve) {
    sessionResolve = sessionResolve || function (id) { return id; };
    return proxyquire(xmlBuilderPath, {
        '*/cartridge/scripts/migration/productMigration/productTransformer': {
            transformProduct: function () { return {}; },
            resolveMasterProductId: function (p) { return p && p.id ? String(p.id) : ''; }
        },
        '*/cartridge/scripts/migration/config/nativeFieldMap': {
            getRule: function () { return null; },
            isMapAction: function () { return false; },
            resolveSystemId: function (task, id) {
                var sys = {
                    longDescription: 'longDescription',
                    name: 'name',
                    ID: 'ID'
                };
                return sys[id] || null;
            }
        },
        '*/cartridge/scripts/migration/core/attrIdMapSession': {
            read: function () { return {}; },
            resolve: sessionResolve
        }
    });
}

function sampleTransformed(overrides) {
    overrides = overrides || {};
    var base = {
        productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106',
        nameLocales: { 'en-US': 'Bulk Seed Product 79' },
        longDescriptionLocales: {
            'en-GB': 'hello this is product description',
            'de-DE': 'Hallo, dies ist die Produktbeschreibung.'
        },
        onlineFlag: true,
        categories: [],
        variants: [],
        hasVariants: false,
        productKind: 'base'
    };
    var k;
    for (k in overrides) {
        if (Object.prototype.hasOwnProperty.call(overrides, k)) base[k] = overrides[k];
    }
    return base;
}

describe('product localized XML', function () {
    it('preserves all CT locales on longDescription from product-description session map', function () {
        var transformer = loadTransformer({ 'product-description': 'longDescription' });
        var t = transformer.transformProduct({
            id: '882038c7-1fe6-4b0f-aec3-48fd2da9b106',
            key: 'bulk-seed-product-0000079',
            masterData: {
                published: true,
                current: {
                    name: { 'en-US': 'Bulk Seed Product 79' },
                    slug: { 'en-US': 'bulk-seed-product-0000079' },
                    masterVariant: {
                        sku: 'SKU-BULK-00000079',
                        attributes: [{
                            name: 'product-description',
                            value: {
                                'en-GB': 'hello this is product description',
                                'de-DE': 'Hallo, dies ist die Produktbeschreibung.'
                            }
                        }]
                    },
                    variants: []
                }
            }
        });
        assert.deepEqual(t.longDescriptionLocales, {
            'en-GB': 'hello this is product description',
            'de-DE': 'Hallo, dies ist die Produktbeschreibung.'
        });
        assert.equal(t.longDescription, 'hello this is product description');
    });

    it('uses expanded Category.key for classification and assignments', function () {
        var transformer = loadTransformer();
        var t = transformer.transformProduct({
            id: '882038c7-1fe6-4b0f-aec3-48fd2da9b106',
            masterData: {
                published: true,
                current: {
                    name: { 'en-US': 'Bulk Seed Product 79' },
                    masterVariant: { sku: 'SKU-1', attributes: [] },
                    variants: [],
                    categories: [{
                        typeId: 'category',
                        id: '9d894fa0-ed9d-4a1c-9cf3-261bc9195128',
                        obj: { id: '9d894fa0-ed9d-4a1c-9cf3-261bc9195128', key: 'furniture-chairs' }
                    }]
                }
            }
        });
        assert.deepEqual(t.categories, ['furniture-chairs']);
        assert.equal(t.classificationCategory, 'furniture-chairs');
    });

    it('emits long-description for every locale plus x-default', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed(), []);
        assert.match(result.productXml, /long-description xml:lang="x-default">hello this is product description/);
        assert.match(result.productXml, /long-description xml:lang="en-GB">hello this is product description/);
        assert.match(result.productXml, /long-description xml:lang="de-DE">Hallo, dies ist die Produktbeschreibung\./);
        assert.match(result.productXml, /display-name xml:lang="en-US">Bulk Seed Product 79/);
    });

    it('emits localized custom-attribute entries for CT ltext attrs', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = '882038c7-1fe6-4b0f-aec3-48fd2da9b106';
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            hasVariants: true,
            masterAttributes: [{
                name: 'product-spec',
                value: 'Master owned spec'
            }],
            variants: [{
                productId: masterId + '-1',
                sku: 'SKU-BULK-00000079',
                isDefault: true,
                attributes: [{
                    name: 'care-instructions',
                    value: {
                        'en-GB': 'Wash cold',
                        'de-DE': 'Kalt waschen'
                    }
                }]
            }]
        }), ['care-instructions', 'product-spec']);
        assert.match(result.productXml, new RegExp('product product-id="' + masterId + '"'));
        assert.match(result.productXml, new RegExp('product product-id="' + masterId + '-1"'));
        assert.match(result.productXml, /custom-attribute attribute-id="product-spec">Master owned spec/);
        assert.match(result.productXml, /care-instructions" xml:lang="x-default">Wash cold/);
        assert.match(result.productXml, /care-instructions" xml:lang="de-DE">Kalt waschen/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">Kalt waschen/);
        assert.match(result.productXml, /variation-attribute-value value="Wash cold"/);
        assert.match(result.productXml, /variant product-id="882038c7-1fe6-4b0f-aec3-48fd2da9b106-1"/);
    });

    it('uses finish-label key on the custom attr and locales on display-value', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [{
                    name: 'finish-label',
                    value: {
                        'en-GB': 'Silver',
                        'de-DE': 'Silber',
                        'en-US': 'Silver'
                    }
                }]
            }]
        }), ['finish-label']);
        assert.match(result.productXml, /finish-label" xml:lang="x-default">Silver/);
        assert.match(result.productXml, /finish-label" xml:lang="de-DE">Silber/);
        assert.match(result.productXml, /variation-attribute-value value="Silver"/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">Silber/);
        assert.match(result.productXml, /display-value xml:lang="en-US">Silver/);
    });

    it('emits lenum labels as localized custom attributes', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [{
                    name: 'color-label',
                    value: {
                        key: 'sage',
                        label: {
                            'en-GB': 'Sage',
                            'de-DE': 'Salbei',
                            'en-US': 'Sage'
                        }
                    }
                }]
            }]
        }), ['color-label']);
        assert.match(result.productXml, /color-label" xml:lang="x-default">Sage/);
        assert.match(result.productXml, /color-label" xml:lang="de-DE">Salbei/);
        assert.match(result.productXml, /variation-attribute-value value="sage"/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">Salbei/);
        assert.match(result.productXml, /display-value xml:lang="en-US">Sage/);
    });

    it('matches SFCC export: variation value is the key; locales live on display-value', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: '00099b33-c7e1-4e2b-b84e-7ccb8f827cd3-1',
                sku: 'MPC-02',
                isDefault: true,
                attributes: [
                    { name: 'search-color', value: { 'en-GB': 'purple', 'de-DE': 'purrrple' } },
                    { name: 'color-code', value: '#DDA0DD' },
                    { name: 'color-label', value: { 'en-GB': 'Plum', 'de-DE': 'Pflaume' } },
                    {
                        name: 'productspec',
                        value: {
                            'en-GB': '- Machine washable\n- Does not include pillow',
                            'de-DE': '- Maschinenwaschbar'
                        }
                    }
                ]
            }]
        }), ['search-color', 'color-code', 'color-label', 'productspec']);
        assert.match(result.productXml, /search-color" xml:lang="x-default">purple/);
        assert.match(result.productXml, /search-color" xml:lang="de-DE">purrrple/);
        assert.match(result.productXml, /variation-attribute-value value="purple"/);
        assert.match(result.productXml, /display-value xml:lang="x-default">Purple/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">purrrple/);
        assert.match(result.productXml, /custom-attribute attribute-id="color-code">#DDA0DD/);
        assert.notMatch(result.productXml, /color-code" xml:lang=/);
        assert.match(result.productXml, /color-label" xml:lang="x-default">Plum/);
        assert.match(result.productXml, /color-label" xml:lang="de-DE">Pflaume/);
        assert.match(result.productXml, /productspec" xml:lang="x-default">- Machine washable/);
        assert.match(result.productXml, /productspec" xml:lang="de-DE">- Maschinenwaschbar/);
        assert.notMatch(result.productXml, /variation-attribute attribute-id="productspec"/);
    });

    it('puts xml:lang on localizable custom-attribute entries and on display-value', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [{
                    name: 'care-instructions',
                    value: { 'en-GB': 'Wash cold', 'de-DE': 'Kalt waschen' }
                }]
            }]
        }), ['care-instructions']);
        assert.match(result.productXml, /care-instructions" xml:lang="x-default">Wash cold/);
        assert.match(result.productXml, /care-instructions" xml:lang="de-DE">Kalt waschen/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">Kalt waschen/);
    });

    it('rewrites classification and assignment UUIDs to category keys', function () {
        var xmlBuilder = loadXmlBuilder();
        var uuid = '9d894fa0-ed9d-4a1c-9cf3-261bc9195128';
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            categories: [uuid],
            classificationCategory: uuid
        }), [], {
            catalogId: 'demo-storefront-catalog',
            categoryIdToSfcc: { '9d894fa0-ed9d-4a1c-9cf3-261bc9195128': 'furniture-chairs' }
        });
        assert.match(result.productXml, /<classification-category catalog-id="demo-storefront-catalog">furniture-chairs<\/classification-category>/);
        assert.match(result.categoryXml, /category-assignment category-id="furniture-chairs"/);
        assert.notMatch(result.productXml, /9d894fa0-ed9d-4a1c-9cf3-261bc9195128/);
        assert.notMatch(result.categoryXml, /9d894fa0-ed9d-4a1c-9cf3-261bc9195128/);
    });

    it('matches apparel catalog product element order and defaults', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            taxClassId: 'standard',
            variants: [{
                productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [{ name: 'color', value: 'JJV61XX' }]
            }]
        }), ['color']);
        var xml = result.productXml;
        assert.match(xml, /<min-order-quantity>1<\/min-order-quantity>/);
        assert.match(xml, /<step-quantity>1<\/step-quantity>/);
        assert.notMatch(xml, /store-force-price-flag/);
        assert.notMatch(xml, /store-non-inventory-flag/);
        assert.match(xml, /<store-attributes>[\s\S]*<force-price-flag>false<\/force-price-flag>/);
        assert.notMatch(xml, /searchable-if-unavailable-flag/);
        assert.match(xml, /custom-attribute attribute-id="color">JJV61XX/);
        assert.notMatch(xml, /color" xml:lang=/);
        assert.match(xml, /display-name xml:lang="x-default">Color/);
        assert.match(xml, /variation-attribute-value value="JJV61XX"/);
        assert.match(xml, /product product-id="882038c7-1fe6-4b0f-aec3-48fd2da9b106-1"[\s\S]*searchable-flag>true[\s\S]*page-attributes\/>/);
        assert.match(xml, /display-name xml:lang="x-default">Bulk Seed Product 79/);
    });

    it('emits page-attributes in catalog.xsd order', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            metaTitle: 'Title',
            metaDescription: 'Desc',
            metaKeywords: 'kw',
            slug: 'my-slug'
        }), []);
        var page = result.productXml.match(/<page-attributes>[\s\S]*?<\/page-attributes>/);
        assert.ok(page);
        var block = page[0];
        assert.ok(block.indexOf('page-title') < block.indexOf('page-description'));
        assert.ok(block.indexOf('page-description') < block.indexOf('page-keywords'));
        assert.ok(block.indexOf('page-keywords') < block.indexOf('page-url'));
    });

    it('writes set-product members as UUID product-ids, not CT+nodash', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productKind: 'set',
            hasVariants: false,
            variants: [],
            setProducts: [
                { productId: 'ddde353a-cda9-415f-82e4-b8097e6188b0' },
                { productId: '980c99dc-045e-4917-a722-101be937aed5' }
            ]
        }), []);
        assert.match(result.productXml, /product-set-product product-id="ddde353a-cda9-415f-82e4-b8097e6188b0"/);
        assert.match(result.productXml, /product-set-product product-id="980c99dc-045e-4917-a722-101be937aed5"/);
        assert.notMatch(result.productXml, /product-id="CT/);
    });

    it('omits xml:lang when the BM definition is not localizable', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: 'fe8c92b1-c032-460e-8257-b29f2f482b38-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [
                    { name: 'search-color', value: { 'en-GB': 'purple', 'de-DE': 'purrrple' } },
                    { name: 'color-label', value: { 'en-GB': 'Plum', 'de-DE': 'Pflaume' } },
                    {
                        name: 'productspec',
                        value: {
                            'en-GB': '- Machine washable\n- Does not include pillow',
                            'de-DE': '- Maschinenwaschbar'
                        }
                    }
                ]
            }]
        }), ['search-color', 'color-label', 'productspec'], {
            localizableAttrIds: {
                'search-color': false,
                'color-label': false,
                productspec: false
            }
        });
        assert.match(result.productXml, /custom-attribute attribute-id="search-color">purple/);
        assert.notMatch(result.productXml, /search-color" xml:lang=/);
        assert.match(result.productXml, /custom-attribute attribute-id="color-label">Plum/);
        assert.notMatch(result.productXml, /color-label" xml:lang=/);
        assert.match(result.productXml, /custom-attribute attribute-id="productspec">- Machine washable/);
        assert.notMatch(result.productXml, /productspec" xml:lang=/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">purrrple/);
    });

    it('writes xml:lang when the BM definition is localizable', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: 'fe8c92b1-c032-460e-8257-b29f2f482b38-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [
                    { name: 'search-color', value: { 'en-GB': 'purple', 'de-DE': 'purrrple' } },
                    {
                        name: 'productspec',
                        value: {
                            'en-GB': '- Machine washable',
                            'de-DE': '- Maschinenwaschbar'
                        }
                    }
                ]
            }]
        }), ['search-color', 'productspec'], {
            localizableAttrIds: {
                'search-color': true,
                productspec: true
            }
        });
        assert.match(result.productXml, /search-color" xml:lang="x-default">purple/);
        assert.match(result.productXml, /search-color" xml:lang="de-DE">purrrple/);
        assert.match(result.productXml, /productspec" xml:lang="x-default">- Machine washable/);
        assert.match(result.productXml, /productspec" xml:lang="de-DE">- Maschinenwaschbar/);
        assert.match(result.productXml, /variation-attribute-value value="purple"/);
    });

    it('adds xml:lang on every entry when the SFCC def is localizable, even for a single value', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variants: [{
                productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [{ name: 'color', value: 'JJV61XX' }]
            }]
        }), ['color'], { localizableAttrIds: { color: true } });
        assert.match(result.productXml, /color" xml:lang="x-default">JJV61XX/);
        assert.notMatch(result.productXml, /custom-attribute attribute-id="color">JJV61XX/);
    });

    it('falls back to the scalar name with xml:lang when nameLocales is empty', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            nameLocales: {},
            name: 'Bulk Seed Product 79'
        }), []);
        assert.match(result.productXml, /display-name xml:lang="x-default">Bulk Seed Product 79/);
    });

    it('writes CT manufacturer-sku on variant products only', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = '882038c7-1fe6-4b0f-aec3-48fd2da9b106';
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            manufacturerSku: 'SKU-MASTER-SHOULD-NOT-APPEAR',
            hasVariants: true,
            variants: [{
                productId: masterId + '-1',
                sku: 'SKU-VARIANT-1',
                isDefault: true,
                attributes: []
            }]
        }), []);
        var xml = result.productXml;
        var splitAt = xml.indexOf('product product-id="' + masterId + '-1"');
        assert.isTrue(splitAt > 0);
        assert.notMatch(xml.substring(0, splitAt), /manufacturer-sku/);
        assert.match(xml.substring(splitAt), /manufacturer-sku>SKU-VARIANT-1/);
    });

    it('writes CT key as a custom attribute when created in BM', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            ctpKey: 'bulk-seed-product-0000079'
        }), [], { localizableAttrIds: { key: false } });
        assert.match(result.productXml, /custom-attribute attribute-id="key">bulk-seed-product-0000079/);
    });

    it('does not write CT key as custom attr when mapped to an SFCC system field', function () {
        var xmlBuilder = loadXmlBuilder(function (id) {
            return id === 'key' ? 'ID' : id;
        });
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            ctpKey: 'bulk-seed-product-0000079'
        }), ['key'], { localizableAttrIds: { key: false } });
        assert.notMatch(result.productXml, /attribute-id="key"/);
    });
});
