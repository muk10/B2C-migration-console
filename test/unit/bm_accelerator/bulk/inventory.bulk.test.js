'use strict';

var expect = require('chai').expect;
var fixtures = require('../fixtures/ctpBulkFixtures');
var pipeline = require('../helpers/bulkPipelineRunner');

describe('Bulk data migration — Inventory Lists', function () {
    this.timeout(0);

    it('generates synthetic CT inventory entries (sanity)', function () {
        var data = fixtures.inventoryEntries(100, 3);
        expect(data.entries).to.have.length(100);
        expect(data.channels).to.have.length(3);
    });

    it('transforms and aggregates inventory at target count in paginated batches', function () {
        var count  = fixtures.targetCount('inventory');
        var result = pipeline.runInventoryPipelineCount(count, { aggregate: true, listId: 'bulk-inv-agg' });

        expect(result.failed).to.equal(0);
        expect(result.built).to.be.at.most(count);
        expect(result.built).to.be.above(0);
        expect(result.batches).to.equal(Math.ceil(count / pipeline.BATCH_SIZES.inventory));
    });

    it('exports per-channel inventory without aggregation (sample)', function () {
        var data      = fixtures.inventoryEntries(800, 2);
        var channelId = data.channels[0].id;
        var filtered  = data.entries.filter(function (e) {
            return e.supplyChannel.id === channelId;
        });
        var result = pipeline.runInventoryPipeline(filtered, { aggregate: false, listId: 'bulk-inv-ch0' });

        expect(result.failed).to.equal(0);
        expect(result.built).to.equal(filtered.length);
    });

    it('produces valid SFCC inventory-list IMPEX XML (sanity)', function () {
        var xmlBuilder  = require('../helpers/cartridgeLoader').requireCartridge(
            'inventoryMigration/inventoryXmlBuilder'
        );
        var transformer = require('../helpers/cartridgeLoader').requireCartridge(
            'inventoryMigration/inventoryTransformer'
        );
        var data    = fixtures.inventoryEntries(10, 1);
        var records = transformer.aggregateBySku(data.entries);
        var xml     = xmlBuilder.buildXml(records, 'test-list', 'bulk');

        expect(xml.xml).to.include('inventory-list');
        expect(xml.xml).to.include('<default-instock>');
        expect(xml.xml).to.not.include('<ats>');
        expect(xml.xml).to.not.include('<turnover>');
        expect(xml.xml).to.include('<preorder-backorder-handling>');
        expect(xml.built).to.equal(records.length);
    });
});
