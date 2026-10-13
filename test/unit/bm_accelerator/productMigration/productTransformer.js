'use strict';

/* eslint-env mocha */

var assert = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path = require('path');

var transformerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/productMigration/productTransformer.js'
);

/**
 * Stub resolver that mirrors curated CT Product aliases + optional session maps.
 */
function loadTransformer(sessionMap) {
    sessionMap = sessionMap || {};
    var curated = {
        ID:               ['id'],
        name:             ['name'],
        shortDescription: ['description'],
        longDescription:  [],
        pageURL:          ['slug'],
        pageTitle:        ['metaTitle'],
        pageDescription:  ['metaDescription'],
        pageKeywords:     ['metaKeywords'],
        manufacturerSKU:  ['sku'],
        taxClassID:       ['taxCategory'],
        brand:            [],
        manufacturerName: [],
        EAN:              [],
        UPC:              [],
        onlineFlag:       ['masterData.published'],
        minOrderQuantity: [],
        stepQuantity:     [],
        unitQuantity:     [],
        unit:             [],
        unitMeasure:      []
    };
    function getSourceKeys(platformId, task, sfccField) {
        var out = [];
        var keys = Object.keys(sessionMap);
        var i;
        for (i = 0; i < keys.length; i++) {
            if (sessionMap[keys[i]] === sfccField) out.push(keys[i]);
        }
        return out.concat(curated[sfccField] || []);
    }
    return proxyquire(transformerPath, {
        '*/cartridge/scripts/migration/core/systemFieldResolver': {
            getSourceKeys: getSourceKeys,
            resolve: function (opts) {
                var get = opts.getSourceValue;
                var sources = getSourceKeys(opts.platformId, opts.task, opts.sfccField);
                var i;
                for (i = 0; i < sources.length; i++) {
                    var val = get(sources[i]);
                    if (val) return val;
                }
                return '';
            }
        }
    });
}

function sampleProduct(overrides) {
    overrides = overrides || {};
    return {
        id: overrides.id || '11111111-1111-1111-1111-111111111111',
        key: overrides.key != null ? overrides.key : 'demo-product-key',
        taxCategory: overrides.taxCategory || { id: 'standard' },
        masterData: {
            published: overrides.published != null ? overrides.published : true,
            current: {
                name: { en: 'Demo' },
                description: { en: 'Short from CT description' },
                slug: { en: 'demo-slug' },
                metaTitle: { en: 'Meta Title' },
                metaDescription: { en: 'Meta Desc' },
                metaKeywords: { en: 'a,b' },
                masterVariant: {
                    sku: 'DEMO-SKU',
                    attributes: overrides.attrs || []
                },
                variants: []
            }
        }
    };
}

describe('productTransformer map-driven system fields', function () {
    it('uses CT id for productId (schema id → ID), not key', function () {
        var transformer = loadTransformer({});
        var id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        var t = transformer.transformProduct(sampleProduct({
            id: id,
            key: 'should-not-be-product-id'
        }));
        assert.equal(t.productId, id);
        assert.notEqual(t.productId, 'should-not-be-product-id');
        assert.equal(t.ctpKey, 'should-not-be-product-id');
    });

    it('resolveMasterProductId follows id → ID and never prefers key', function () {
        var transformer = loadTransformer({});
        var id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        var pid = transformer.resolveMasterProductId({
            id: id,
            key: 'human-key'
        });
        assert.equal(pid, id);
    });

    it('does not use CT key for product-id even when session maps key → ID', function () {
        var transformer = loadTransformer({ key: 'ID' });
        var id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        var t = transformer.transformProduct(sampleProduct({
            id: id,
            key: 'human-key'
        }));
        assert.equal(t.productId, id);
        assert.equal(t.ctpKey, 'human-key');
    });

    it('reads the product type key from the expanded product type', function () {
        var transformer = loadTransformer({});
        var p = sampleProduct();
        p.productType = { typeId: 'product-type', id: '1e9527f9-a358-4902-b589-9b37fe229595', obj: { key: 'personalizable', attributes: [] } };
        assert.equal(transformer.transformProduct(p).ctpProductTypeKey, 'personalizable');
        assert.equal(transformer.transformProduct(sampleProduct()).ctpProductTypeKey, '');
    });

    it('maps description → shortDescription via schema', function () {
        var transformer = loadTransformer({});
        var t = transformer.transformProduct(sampleProduct());
        assert.equal(t.shortDescription, 'Short from CT description');
    });

    it('fills longDescription from product_description via session map', function () {
        var transformer = loadTransformer({ product_description: 'longDescription' });
        var t = transformer.transformProduct(sampleProduct({
            attrs: [
                { name: 'product_description', value: { en: 'Full product details body' } }
            ]
        }));
        assert.equal(t.longDescription, 'Full product details body');
    });

    it('matches CT hyphenated attr name product-description to session key product_description', function () {
        var transformer = loadTransformer({ product_description: 'longDescription' });
        var t = transformer.transformProduct(sampleProduct({
            attrs: [
                {
                    name: 'product-description',
                    value: {
                        'en-GB': 'hello this is product description',
                        'de-DE': 'Hallo, dies ist die Produktbeschreibung.'
                    }
                }
            ]
        }));
        assert.equal(t.longDescription, 'hello this is product description');
        assert.deepEqual(t.longDescriptionLocales, {
            'en-GB': 'hello this is product description',
            'de-DE': 'Hallo, dies ist die Produktbeschreibung.'
        });
    });

    it('keeps all locales on curated name / description fields', function () {
        var transformer = loadTransformer({});
        var p = sampleProduct();
        p.masterData.current.name = {
            'en-GB': 'Demo GB',
            'de-DE': 'Demo DE'
        };
        p.masterData.current.description = {
            'en-GB': 'Short GB',
            'de-DE': 'Kurz DE'
        };
        var t = transformer.transformProduct(p);
        assert.deepEqual(t.nameLocales, { 'en-GB': 'Demo GB', 'de-DE': 'Demo DE' });
        assert.deepEqual(t.shortDescriptionLocales, { 'en-GB': 'Short GB', 'de-DE': 'Kurz DE' });
    });

    it('finds product_description on a non-master variant when session-mapped', function () {
        var transformer = loadTransformer({ product_description: 'longDescription' });
        var p = sampleProduct({ attrs: [] });
        p.masterData.current.variants = [{
            sku: 'V2',
            attributes: [
                { name: 'product_description', value: 'Desc only on variant' }
            ]
        }];
        var t = transformer.transformProduct(p);
        assert.equal(t.longDescription, 'Desc only on variant');
    });

    it('does not invent minOrderQuantity or stepQuantity when unmapped', function () {
        var transformer = loadTransformer({});
        var t = transformer.transformProduct(sampleProduct());
        assert.equal(t.minOrderQuantity, '');
        assert.equal(t.stepQuantity, '');
    });

    it('maps sku → manufacturerSKU and taxCategory → taxClassID', function () {
        var transformer = loadTransformer({});
        var t = transformer.transformProduct(sampleProduct());
        assert.equal(t.manufacturerSku, 'DEMO-SKU');
        assert.equal(t.taxClassId, 'standard');
    });

    it('assigns variant product-ids as {masterId}-{n} starting at 1', function () {
        var transformer = loadTransformer({});
        var masterId = '2c8a4c2d-95bb-443b-9e50-a3302c09e6eb';
        var p = sampleProduct({ id: masterId, attrs: [{ name: 'product-spec', value: 'spec-on-master' }] });
        p.masterData.current.variants = [
            { sku: 'SKU-B', attributes: [{ name: 'color', value: 'blue' }] },
            { sku: 'SKU-C', attributes: [{ name: 'color', value: 'red' }] }
        ];
        var t = transformer.transformProduct(p);
        assert.equal(t.productId, masterId);
        assert.lengthOf(t.variants, 3);
        assert.equal(t.variants[0].productId, masterId + '-1');
        assert.equal(t.variants[1].productId, masterId + '-2');
        assert.equal(t.variants[2].productId, masterId + '-3');
        assert.isTrue(t.variants[0].isDefault);
        assert.equal(t.variants[0].sku, 'DEMO-SKU');
        assert.deepEqual(t.masterAttributes, [{ name: 'product-spec', value: 'spec-on-master' }]);
    });

    it('projects native and custom CT media into deduplicated variant images', function () {
        var transformer = loadTransformer({});
        var fallbackUrl = 'https://cdn.media.amplience.net/i/marsmmsnonprod/product_fallback';
        var p = sampleProduct({
            attrs: [
                { name: 'imageUrls', value: [fallbackUrl] },
                {
                    name: 'mediaReferences',
                    value: [[
                        { name: 'mediaType', value: { key: 'image', label: 'Image' } },
                        { name: 'mediaUrl', value: fallbackUrl },
                        { name: 'mediaAltText', value: 'Fallback pack shot' },
                        { name: 'mediaAltTextLocalized', value: { en: 'Fallback pack shot', de: 'Packungsbild' } }
                    ], [
                        { name: 'mediaType', value: { key: 'video', label: 'Video' } },
                        { name: 'mediaUrl', value: 'https://cdn.media.amplience.net/v/demo/video' }
                    ]]
                }
            ]
        });
        p.masterData.current.masterVariant.images = [{
            url: 'https://cdn.media.amplience.net/i/marsmmsnonprod/hero',
            label: 'Hero image'
        }];

        var t = transformer.transformProduct(p);

        assert.lengthOf(t.masterImages, 2);
        assert.deepEqual(t.masterImages[0], {
            url: 'https://cdn.media.amplience.net/i/marsmmsnonprod/hero',
            alt: 'Hero image',
            altLocales: {}
        });
        assert.deepEqual(t.masterImages[1], {
            url: fallbackUrl,
            alt: 'Fallback pack shot',
            altLocales: { en: 'Fallback pack shot', de: 'Packungsbild' }
        });
        assert.deepEqual(t.variants[0].images, t.masterImages);
        assert.deepEqual(t.masterAttributes, p.masterData.current.masterVariant.attributes);
    });

    it('falls back to CT searchKeywords when metaKeywords is empty', function () {
        var transformer = loadTransformer({});
        var p = sampleProduct();
        p.masterData.current.metaKeywords = null;
        p.masterData.current.searchKeywords = {
            en: [{ text: 'milk chocolate' }, { text: 'baked snacks' }],
            de: [{ text: 'Schokolade' }]
        };

        var t = transformer.transformProduct(p);
        assert.deepEqual(t.metaKeywordsLocales, {
            en: 'milk chocolate, baked snacks',
            de: 'Schokolade'
        });
        assert.equal(t.metaKeywords, 'milk chocolate, baked snacks');
    });

    it('derives only genuine scalar or enum attributes that vary as variation axes', function () {
        var transformer = loadTransformer({});
        var p = sampleProduct({
            attrs: [
                { name: 'packCount', value: { key: '1-count', label: { en: '1 count' } } },
                { name: 'pricePerEachForUS', value: 449 },
                { name: 'pdpUrl', value: { en: '/p?sku=one' } },
                { name: 'flavors', value: [{ key: 'milk-chocolate', label: 'Milk Chocolate' }] }
            ]
        });
        p.productType = {
            obj: {
                attributes: [
                    { name: 'packCount', type: { name: 'lenum' }, attributeConstraint: 'CombinationUnique' },
                    { name: 'pricePerEachForUS', type: { name: 'number' }, attributeConstraint: 'None' },
                    { name: 'pdpUrl', type: { name: 'ltext' }, attributeConstraint: 'None' },
                    { name: 'flavors', type: { name: 'set' }, attributeConstraint: 'None' }
                ]
            }
        };
        p.masterData.current.variants = [{
            sku: 'SKU-B',
            attributes: [
                { name: 'packCount', value: { key: '6-count', label: { en: '6 count' } } },
                { name: 'pricePerEachForUS', value: 408.16 },
                { name: 'pdpUrl', value: { en: '/p?sku=two' } },
                { name: 'flavors', value: [{ key: 'milk-chocolate', label: 'Milk Chocolate' }] }
            ]
        }];

        var t = transformer.transformProduct(p);
        assert.deepEqual(t.variationAttributeNames, ['packCount']);
    });

    it('reads only masterData.current and ignores staged', function () {
        var transformer = loadTransformer({});
        var p = sampleProduct({
            attrs: [{ name: 'product-spec', value: 'from-current' }]
        });
        p.masterData.current.name = { en: 'Current Name' };
        p.masterData.staged = {
            name: { en: 'Staged Name' },
            description: { en: 'Staged description only' },
            masterVariant: {
                sku: 'STAGED-SKU',
                attributes: [{ name: 'product-spec', value: 'from-staged' }]
            },
            variants: []
        };
        var t = transformer.transformProduct(p);
        assert.equal(t.name, 'Current Name');
        assert.equal(t.shortDescription, 'Short from CT description');
        assert.equal(t.manufacturerSku, 'DEMO-SKU');
        assert.deepEqual(t.masterAttributes, [{ name: 'product-spec', value: 'from-current' }]);
        assert.notEqual(t.name, 'Staged Name');
        assert.notEqual(t.manufacturerSku, 'STAGED-SKU');
    });
});
