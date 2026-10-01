'use strict';

/* eslint-env mocha */

var assert     = require('chai').assert;
var proxyquire = require('proxyquire').noCallThru();
var path       = require('path');

var runnerPath = path.join(
    __dirname,
    '../../../../commerce-rc-b2c-migration-console-app/cartridges/bm_cartridges/bm_accelerator/cartridge/scripts/migration/productMigration/fullProductMigrationRunner.js'
);
describe('fullProductMigrationRunner local IMPEX accumulation', function () {
    var originalSession;

    beforeEach(function () {
        originalSession = global.session;
        global.session = { custom: {} };
    });

    afterEach(function () {
        global.session = originalSession;
    });

    it('creates the product directory before writing temporary batch files', function () {
        var files = {};
        var directories = { '/impex': true };
        var resolvedStorage = '';

        /**
         * Minimal in-memory dw.io.File test double.
         * @param {string} filePath file or directory path
         */
        function File(filePath) {
            this.path = filePath;
        }
        File.IMPEX = '/impex';
        File.SEPARATOR = '/';
        File.prototype.exists = function () {
            return !!directories[this.path]
                || Object.prototype.hasOwnProperty.call(files, this.path);
        };
        File.prototype.isFile = function () {
            return Object.prototype.hasOwnProperty.call(files, this.path);
        };
        File.prototype.mkdirs = function () {
            directories[this.path] = true;
            return true;
        };
        File.prototype.remove = function () {
            delete files[this.path];
            return true;
        };
        File.prototype.length = function () {
            return Object.prototype.hasOwnProperty.call(files, this.path)
                ? Buffer.byteLength(files[this.path], 'utf8') : 0;
        };

        /**
         * File writer that rejects writes when the parent directory is missing.
         * @param {File} file target file
         * @param {string} encoding character encoding
         * @param {boolean} append append mode
         */
        function FileWriter(file, encoding, append) {
            var parent = file.path.substring(0, file.path.lastIndexOf('/'));
            if (!directories[parent]) {
                throw new Error('Parent directory does not exist: ' + parent);
            }
            this.file = file;
            this.append = !!append;
            if (!this.append || !Object.prototype.hasOwnProperty.call(files, file.path)) {
                files[file.path] = '';
            }
        }
        FileWriter.prototype.write = function (contents) {
            files[this.file.path] += String(contents);
        };
        FileWriter.prototype.close = function () {};

        /**
         * Minimal line reader for accumulated batch fragments.
         * @param {File} file source file
         */
        function FileReader(file) {
            if (!Object.prototype.hasOwnProperty.call(files, file.path)) {
                throw new Error('File does not exist: ' + file.path);
            }
            this.lines = String(files[file.path]).split(/\r?\n/);
            this.index = 0;
        }
        FileReader.prototype.readLine = function () {
            if (this.index >= this.lines.length) return null;
            var line = this.lines[this.index];
            this.index += 1;
            return line;
        };
        FileReader.prototype.close = function () {};

        var runner = proxyquire(runnerPath, {
            '*/cartridge/scripts/migration/productMigration/productSplitUtils': {
                MAX_PER_FILE: 2,
                MAX_BYTES_PER_FILE: 100 * 1024 * 1024,
                expectedFileCount: function (total) { return Math.ceil(total / 2); },
                shouldRotate: function (count, bytes) {
                    return count >= 2 || bytes >= 100 * 1024 * 1024;
                },
                buildPartFileName: function (stem, part) {
                    return stem.replace(/\.xml$/, '-p' + (part < 10 ? '000' : '00') + part + '.xml');
                }
            },
            '*/cartridge/scripts/migration/productMigration/ctpProductFetcher': {
                fetchBatch: function () {
                    return { results: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], total: 3, pageSize: 50 };
                },
                fetchCategoryIdMap: function () { return null; }
            },
            // bundle member lookup (fetchBundleMembers): these test products have no bundle lines
            '*/cartridge/scripts/migration/productMigration/productTransformer': {
                bundleMemberIds: function () { return []; }
            },
            '*/cartridge/scripts/migration/productMigration/productXmlBuilder': {
                XML_FOOTER: '</catalog>\n',
                xmlHeader: function (catalogId, imageBaseUrl) {
                    return '<catalog image-base="' + imageBaseUrl + '">\n';
                },
                buildXmlParts: function (rawProducts) {
                    var productXml = '';
                    var categoryXml = '';
                    for (var i = 0; i < rawProducts.length; i++) {
                        productXml += '<product product-id="' + rawProducts[i].id + '"/>\n';
                        categoryXml += '<category-assignment product-id="' + rawProducts[i].id + '"/>\n';
                    }
                    return {
                        productsXml: productXml,
                        categoriesXml: categoryXml,
                        built: rawProducts.length,
                        failed: 0,
                        errors: [],
                        setCount: 0,
                        bundleCount: 0,
                        imageBaseUrl: 'https://cdn.media.amplience.net'
                    };
                }
            },
            '*/cartridge/scripts/migration/core/migrationFileResolver': {
                getRunDate: function () { return '20260916'; },
                resolveXmlFileName: function (moduleKey, offset, batchSize, storage) {
                    resolvedStorage = storage;
                    return 'ctp-product-20260916-v001.xml';
                },
                getRelativePath: function () { return 'src/migration/product'; }
            },
            '*/cartridge/scripts/migration/core/migrationPaths': {
                getRelativePath: function () { return 'src/migration/product'; }
            },
            '*/cartridge/scripts/migration/sfccClient': {
                getSFCCToken: function () { throw new Error('not needed by this test'); }
            },
            'dw/io/File': File,
            'dw/io/FileWriter': FileWriter,
            'dw/io/FileReader': FileReader,
            'dw/util/HashMap': function () {}
        });

        var result = runner.runBatch(0, 'target-catalog', [], 'commercetools');
        var finalPath = '/impex/src/migration/product/ctp-product-20260916-v001-p0001.xml';
        var secondPath = '/impex/src/migration/product/ctp-product-20260916-v001-p0002.xml';

        assert.isTrue(result.ok);
        assert.isTrue(result.done);
        assert.equal(resolvedStorage, 'local');
        assert.isTrue(directories['/impex/src/migration/product']);
        assert.include(files[finalPath], '<catalog image-base="https://cdn.media.amplience.net">');
        assert.include(files[finalPath], '<product product-id="p1"/>');
        assert.include(files[finalPath], '<category-assignment product-id="p1"/>');
        assert.include(files[finalPath], '</catalog>');
        assert.include(files[finalPath], '<product product-id="p2"/>');
        assert.notInclude(files[finalPath], '<product product-id="p3"/>');
        assert.include(files[secondPath], '<product product-id="p3"/>');
        assert.deepEqual(result.files, [
            'ctp-product-20260916-v001-p0001.xml',
            'ctp-product-20260916-v001-p0002.xml'
        ]);
        assert.isUndefined(global.session.custom.migProdFiles);
        assert.equal(global.session.custom.migProdPart, '3');
    });
});
