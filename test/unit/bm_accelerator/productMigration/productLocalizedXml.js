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

    it('serializes CT collections and limits axes to derived variation attributes', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = 'b3b8332c-b7b0-4707-b84e-c367f5ea287c';
        var selected = ['packCount', 'pricePerEachForUS', 'flavors', 'mediaReferences', 'predesignedLentils'];
        var attrs = [
            { name: 'packCount', value: { key: '1-count', label: { en: '1 count' } } },
            { name: 'pricePerEachForUS', value: 449 },
            { name: 'flavors', value: [{ key: 'milk-chocolate', label: 'Milk Chocolate' }] },
            {
                name: 'mediaReferences',
                value: [[{ name: 'mediaType', value: { key: 'image', label: 'Image' } }]]
            },
            { name: 'predesignedLentils', value: ['yellow', 'blue'] }
        ];
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            hasVariants: true,
            masterAttributes: attrs,
            variationAttributeNames: ['packCount'],
            variants: [{
                productId: masterId + '-1',
                sku: '2000843097',
                isDefault: true,
                attributes: attrs
            }]
        }), selected, {
            localizableAttrIds: {
                packCount: false,
                pricePerEachForUS: false,
                flavors: false,
                mediaReferences: false,
                predesignedLentils: false
            }
        });

        var xml = result.productXml;
        assert.match(xml, /variation-attribute attribute-id="packCount"/);
        assert.notMatch(xml, /variation-attribute attribute-id="pricePerEachForUS"/);
        assert.notMatch(xml, /variation-attribute attribute-id="flavors"/);
        assert.match(xml, /packCount">1-count<\/custom-attribute>/);
        assert.notMatch(xml, /packCount" xml:lang=/);
        assert.match(xml, /attribute-id="flavors">\s*<value>milk-chocolate<\/value>/);
        assert.match(xml, /attribute-id="predesignedLentils">\s*<value>yellow<\/value>\s*<value>blue<\/value>/);
        assert.match(xml, /attribute-id="mediaReferences">[\s\S]*&quot;mediaType&quot;/);
        assert.notMatch(xml, /\[object Object\]/);
    });

    it('writes CT media as external SFCC image groups with relative paths', function () {
        var xmlBuilder = loadXmlBuilder();
        var baseUrl = 'https://cdn.media.amplience.net/i/marsmmsnonprod/product_fallback';
        var transformed = sampleTransformed({
            ctpId: 'b3b8332c-b7b0-4707-b84e-c367f5ea287c',
            masterImages: [{
                url: baseUrl,
                altLocales: { en: 'M&M pack', de: 'M&M Packung' }
            }, {
                url: 'https://other.example.com/not-compatible.jpg',
                alt: 'Different origin'
            }],
            masterAttributes: [{ name: 'imageUrls', value: [baseUrl] }],
            hasVariants: true,
            variants: [{
                productId: 'b3b8332c-b7b0-4707-b84e-c367f5ea287c-1',
                sku: '2000843097',
                isDefault: true,
                images: [{ url: baseUrl, alt: 'Fallback pack shot' }],
                attributes: [{ name: 'imageUrls', value: [baseUrl] }]
            }]
        });

        var result = xmlBuilder.buildXml(
            [{ id: transformed.ctpId }],
            'mms-test-catalog',
            ['imageUrls'],
            function () { return transformed; },
            { localizableAttrIds: { imageUrls: false } }
        );
        var xml = result.xml;

        assert.include(xml, '<header>');
        assert.include(xml, '<http-url>http://cdn.media.amplience.net/</http-url>');
        assert.include(xml, '<https-url>https://cdn.media.amplience.net/</https-url>');
        assert.include(xml, '<image path="i/marsmmsnonprod/product_fallback">');
        assert.include(xml, '<alt xml:lang="x-default">M&amp;M pack</alt>');
        assert.include(xml, '<alt xml:lang="de">M&amp;M Packung</alt>');
        assert.notInclude(xml, 'path="https://');
        assert.notInclude(xml, 'other.example.com/not-compatible.jpg');
        assert.include(xml, '<custom-attribute attribute-id="imageUrls">');
        assert.include(xml, '<value>https://cdn.media.amplience.net/i/marsmmsnonprod/product_fallback</value>');
        assert.equal(result.imageBaseUrl, 'https://cdn.media.amplience.net');

        // SFCC import rejects <images> on variation products: the master owns them all
        var variantAt = xml.indexOf('product product-id="' + transformed.ctpId + '-1"');
        assert.isTrue(variantAt > 0);
        assert.include(xml.substring(0, variantAt), '<images>');
        assert.notInclude(xml.substring(variantAt), '<images>');
        // no variation axis is selected in this fixture (imageUrls is a collection), so no qualified group
        assert.notInclude(xml, '<variation ');
    });

    it('rejects a localized SFCC attribute selected as a variation axis', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = 'master-localized-axis';
        var transformed = sampleTransformed({
            productId: masterId,
            hasVariants: true,
            variationAttributeNames: ['packCount'],
            variants: [{
                productId: masterId + '-1',
                isDefault: true,
                attributes: [{ name: 'packCount', value: '6-count' }]
            }]
        });

        assert.throws(function () {
            xmlBuilder.buildProductXml(transformed, ['packCount'], {
                localizableAttrIds: { packCount: true }
            });
        }, /packCount.*localizable/);
    });

    /**
     * Split product XML into the master part and the variant products part.
     * @param {string} xml - productXml returned by buildProductXml
     * @param {string} firstVariantId - product-id of the first variant product
     * @returns {{ master: string, variants: string }} master XML and everything after it
     */
    function splitMasterAndVariants(xml, firstVariantId) {
        var at = xml.indexOf('product product-id="' + firstVariantId + '"');
        assert.isTrue(at > 0, 'expected variant product ' + firstVariantId + ' after the master');
        return { master: xml.substring(0, at), variants: xml.substring(at) };
    }

    /**
     * Count regex matches in a string.
     * @param {string} str - haystack
     * @param {RegExp} re - global regex
     * @returns {number} number of matches
     */
    function countMatches(str, re) {
        return (str.match(re) || []).length;
    }

    it('moves variant images onto the master as variation image groups', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = 'b3b8332c-b7b0-4707-b84e-c367f5ea287c';
        var cdn = 'https://cdn.media.amplience.net/i/marsmmsnonprod/';
        var makeVariant = function (n, count, img) {
            return {
                productId: masterId + '-' + n,
                sku: 'SKU-' + n,
                isDefault: n === 1,
                images: [{ url: cdn + img, alt: img + ' shot' }],
                attributes: [{ name: 'packCount', value: { key: count, label: { en: count } } }]
            };
        };
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            ctpId: masterId,
            masterImages: [{ url: cdn + 'pack_1' }],
            hasVariants: true,
            variationAttributeNames: ['packCount'],
            variants: [
                makeVariant(1, '1-count', 'pack_1'),
                makeVariant(2, '6-count', 'pack_6'),
                makeVariant(3, '12-count', 'pack_12')
            ]
        }), ['packCount'], {
            externalImageBaseUrl: 'https://cdn.media.amplience.net',
            localizableAttrIds: { packCount: false }
        });
        var parts = splitMasterAndVariants(result.productXml, masterId + '-1');

        assert.notInclude(parts.variants, '<images>');
        assert.notInclude(parts.variants, '<image ');
        // fallback group first, then one qualified group per variant whose images differ
        assert.match(parts.master, /<images>\s*<image-group view-type="large">\s*<image path="i\/marsmmsnonprod\/pack_1"\/>/);
        assert.match(parts.master, /<image-group view-type="large">\s*<variation attribute-id="packCount" value="6-count"\/>\s*<image path="i\/marsmmsnonprod\/pack_6">\s*<alt xml:lang="x-default">pack_6 shot<\/alt>/);
        assert.match(parts.master, /<variation attribute-id="packCount" value="12-count"\/>\s*<image path="i\/marsmmsnonprod\/pack_12">/);
        assert.notMatch(parts.master, /<variation attribute-id="packCount" value="1-count"\/>/);
        assert.notInclude(parts.master, 'variation-value=');
        assert.equal(countMatches(parts.master, /<image-group view-type="medium">/g), 3);
        assert.equal(countMatches(parts.master, /<image-group /g), 9);
        // XSD order: images before tax/brand/page-attributes/variations
        assert.isBelow(parts.master.indexOf('</images>'), parts.master.indexOf('<page-attributes'));
        // the variation axis itself is unchanged
        assert.match(parts.master, /variation-attribute attribute-id="packCount"/);
        assert.match(parts.master, /variation-attribute-value value="1-count"/);
        assert.match(parts.master, /variation-attribute-value value="12-count"/);
    });

    it('groups variation images by the shortest axis prefix that determines them', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = 'shirt';
        var base = 'https://cdn.example.com';
        var makeVariant = function (n, color, size, img) {
            return {
                productId: masterId + '-' + n,
                sku: 'SKU-' + n,
                isDefault: n === 1,
                images: [{ url: base + '/i/' + img }],
                attributes: [{ name: 'color', value: color }, { name: 'size', value: size }]
            };
        };
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            masterImages: [],
            hasVariants: true,
            variationAttributeNames: ['color', 'size'],
            variants: [
                makeVariant(1, 'red', 'S', 'red.jpg'),
                makeVariant(2, 'red', 'M', 'red.jpg'),
                makeVariant(3, 'blue', 'S', 'blue.jpg'),
                makeVariant(4, 'blue', 'M', 'blue.jpg')
            ]
        }), ['color', 'size'], {
            externalImageBaseUrl: base,
            localizableAttrIds: { color: false, size: false }
        });
        var parts = splitMasterAndVariants(result.productXml, masterId + '-1');

        // default variant supplies the fallback when the master has no images
        assert.match(parts.master, /<image-group view-type="large">\s*<image path="i\/red\.jpg"\/>/);
        // images only depend on color → one group per color, no size qualifier
        assert.equal(countMatches(parts.master, /<variation attribute-id="color" value="blue"\/>/g), 3);
        assert.notMatch(parts.master, /<variation attribute-id="color" value="red"\/>/);
        assert.notMatch(parts.master, /<variation attribute-id="size"/);
        assert.equal(countMatches(parts.master, /<image-group /g), 6);
        assert.notInclude(parts.variants, '<images>');
    });

    it('falls back to full axis combinations when images vary by a later axis', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = 'shirt';
        var base = 'https://cdn.example.com';
        var makeVariant = function (n, color, size, img) {
            return {
                productId: masterId + '-' + n,
                sku: 'SKU-' + n,
                isDefault: n === 1,
                images: [{ url: base + '/i/' + img }],
                attributes: [{ name: 'color', value: color }, { name: 'size', value: size }]
            };
        };
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            masterImages: [],
            hasVariants: true,
            variationAttributeNames: ['color', 'size'],
            variants: [
                makeVariant(1, 'red', 'S', '1.jpg'),
                makeVariant(2, 'red', 'M', '2.jpg'),
                makeVariant(3, 'blue', 'S', '3.jpg'),
                makeVariant(4, 'blue', 'M', '4.jpg')
            ]
        }), ['color', 'size'], {
            externalImageBaseUrl: base,
            localizableAttrIds: { color: false, size: false }
        });
        var parts = splitMasterAndVariants(result.productXml, masterId + '-1');

        assert.match(parts.master, /<image-group view-type="large">\s*<image path="i\/1\.jpg"\/>/);
        assert.match(parts.master, /<variation attribute-id="color" value="red"\/>\s*<variation attribute-id="size" value="M"\/>\s*<image path="i\/2\.jpg"\/>/);
        assert.match(parts.master, /<variation attribute-id="color" value="blue"\/>\s*<variation attribute-id="size" value="S"\/>\s*<image path="i\/3\.jpg"\/>/);
        assert.match(parts.master, /<variation attribute-id="color" value="blue"\/>\s*<variation attribute-id="size" value="M"\/>\s*<image path="i\/4\.jpg"\/>/);
        // the default variant's combination equals the fallback → no group of its own
        assert.notMatch(parts.master, /<variation attribute-id="color" value="red"\/>\s*<variation attribute-id="size" value="S"\/>/);
        assert.equal(countMatches(parts.master, /<image-group view-type="small">/g), 4);
    });

    it('merges variant-only images into the fallback group when no variation axis is selected', function () {
        var xmlBuilder = loadXmlBuilder();
        var masterId = 'mug';
        var base = 'https://cdn.example.com';
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: masterId,
            masterImages: [{ url: base + '/i/a.jpg' }],
            hasVariants: true,
            variationAttributeNames: ['color'],
            variants: [{
                productId: masterId + '-1',
                sku: 'SKU-1',
                isDefault: true,
                images: [{ url: base + '/i/a.jpg' }],
                attributes: [{ name: 'color', value: 'red' }]
            }, {
                productId: masterId + '-2',
                sku: 'SKU-2',
                isDefault: false,
                images: [{ url: base + '/i/b.jpg' }],
                attributes: [{ name: 'color', value: 'blue' }]
            }]
        }), [], { externalImageBaseUrl: base });
        var parts = splitMasterAndVariants(result.productXml, masterId + '-1');

        assert.notInclude(result.productXml, '<variation ');
        assert.notMatch(parts.master, /<attributes>/);
        assert.match(parts.master, /<image-group view-type="large">\s*<image path="i\/a\.jpg"\/>\s*<image path="i\/b\.jpg"\/>\s*<\/image-group>/);
        assert.notInclude(parts.variants, '<images>');
    });

    it('writes Shopify variant images as variation groups keyed by the option axis id', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            productId: '7001',
            shopifyId: 'gid://shopify/Product/7001',
            masterImages: [{ url: 'https://cdn.shopify.com/s/files/main.jpg' }],
            hasVariants: true,
            variants: [{
                productId: '41001',
                sku: 'S-RED',
                isDefault: true,
                images: [{ url: 'https://cdn.shopify.com/s/files/red.jpg' }],
                attributes: [{ name: 'Color', value: 'Red' }]
            }, {
                productId: '41002',
                sku: 'S-BLUE',
                isDefault: false,
                images: [{ url: 'https://cdn.shopify.com/s/files/blue.jpg' }],
                attributes: [{ name: 'Color', value: 'Blue' }]
            }]
        }), [], { externalImageBaseUrl: 'https://cdn.shopify.com' });
        var parts = splitMasterAndVariants(result.productXml, '41001');

        assert.match(parts.master, /<image-group view-type="large">\s*<image path="s\/files\/main\.jpg"\/>/);
        assert.match(parts.master, /<variation attribute-id="shopify_Color" value="Red"\/>\s*<image path="s\/files\/red\.jpg"\/>/);
        assert.match(parts.master, /<variation attribute-id="shopify_Color" value="Blue"\/>\s*<image path="s\/files\/blue\.jpg"\/>/);
        assert.match(parts.master, /variation-attribute attribute-id="shopify_Color"/);
        assert.notInclude(parts.variants, '<images>');
    });

    it('keeps plain fallback image groups on sets and on products without variants', function () {
        var xmlBuilder = loadXmlBuilder();
        var base = 'https://cdn.example.com';
        var set = xmlBuilder.buildProductXml(sampleTransformed({
            productId: 'gift-set',
            productKind: 'set',
            hasVariants: false,
            setProducts: [{ productId: 'mug' }],
            masterImages: [{ url: base + '/i/set.jpg', alt: 'Set shot' }]
        }), [], { externalImageBaseUrl: base });
        assert.equal(countMatches(set.productXml, /<image-group /g), 3);
        assert.include(set.productXml, '<alt xml:lang="x-default">Set shot</alt>');
        assert.notInclude(set.productXml, '<variation ');
        assert.isBelow(set.productXml.indexOf('</images>'), set.productXml.indexOf('<product-set-products>'));

        var simple = xmlBuilder.buildProductXml(sampleTransformed({
            productId: 'plain',
            hasVariants: false,
            masterImages: [{ url: base + '/i/a.jpg' }, { url: base + '/i/b.jpg' }, { url: base + '/i/a.jpg' }]
        }), [], { externalImageBaseUrl: base });
        assert.equal(countMatches(simple.productXml, /<image-group /g), 3);
        assert.equal(countMatches(simple.productXml, /<image-group view-type="small">\s*<image path="i\/a\.jpg"\/>\s*<image path="i\/b\.jpg"\/>\s*<\/image-group>/g), 1);
        assert.notInclude(simple.productXml, '<variations>');
    });

    it('puts xml:lang on localizable custom-attribute entries and on display-value', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variationAttributeNames: ['packCount'],
            variants: [{
                productId: '882038c7-1fe6-4b0f-aec3-48fd2da9b106-1',
                sku: 'SKU-1',
                isDefault: true,
                attributes: [{
                    name: 'care-instructions',
                    value: { 'en-GB': 'Wash cold', 'de-DE': 'Kalt waschen' }
                }, {
                    name: 'packCount',
                    value: { key: '6-count', label: { 'en-GB': '6 count', 'de-DE': '6 Packungen' } }
                }]
            }]
        }), ['care-instructions', 'packCount'], {
            localizableAttrIds: { 'care-instructions': true, packCount: false }
        });
        assert.match(result.productXml, /care-instructions" xml:lang="x-default">Wash cold/);
        assert.match(result.productXml, /care-instructions" xml:lang="de-DE">Kalt waschen/);
        assert.match(result.productXml, /display-value xml:lang="de-DE">6 Packungen/);
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
            variationAttributeNames: [],
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
        assert.notMatch(result.productXml, /variation-attribute attribute-id="search-color"/);
    });

    it('adds xml:lang on every entry when the SFCC def is localizable, even for a single value', function () {
        var xmlBuilder = loadXmlBuilder();
        var result = xmlBuilder.buildProductXml(sampleTransformed({
            hasVariants: true,
            variationAttributeNames: [],
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

    it('writes the commercetools product type key as a custom attribute, only when there is one', function () {
        var xmlBuilder = loadXmlBuilder();
        var withType = xmlBuilder.buildProductXml(sampleTransformed({
            ctpProductTypeKey: 'personalizable'
        }), [], { localizableAttrIds: { productType: false } });
        assert.match(withType.productXml, /custom-attribute attribute-id="productType">personalizable</);
        var withoutType = xmlBuilder.buildProductXml(sampleTransformed({}), [], {});
        assert.notMatch(withoutType.productXml, /attribute-id="productType"/);
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
