import * as assert from 'assert';
import * as path from 'path'
import * as fs from 'fs'

import * as engine from "../Engine"
import * as providers from "../Providers"
import * as models from '../Models';

var nconf = require('nconf');

nconf.argv()
    .env()
    .file(__dirname + '/../test.config.json');

describe('E2E Tests', () => {
    describe('Fileshare', () => {
        var runWindowsBasedTest = process.platform == 'win32' ? it : it.skip;
        runWindowsBasedTest('should be able to download build artifact from fileshare', function (done) {
            this.timeout(15000);
            let processor = new engine.ArtifactEngine();

            let processorOptions = new engine.ArtifactEngineOptions();
            processorOptions.itemPattern = "fileshareWithMultipleFiles\\**";
            processorOptions.parallelProcessingLimit = 8;
            processorOptions.retryIntervalInSeconds = 2;
            processorOptions.retryLimit = 2;
            processorOptions.verbose = true;

            var itemsUrl = "//vscsstor/Users/gykuma/ArtifactEngineTestData/dropz/";
            var variables = {};

            var sourceProvider = new providers.FilesystemProvider(itemsUrl, "fileshareWithMultipleFiles");
            var dropLocation = path.join(nconf.get('DROPLOCATION'));
            var destProvider = new providers.FilesystemProvider(dropLocation);

            processor.processItems(sourceProvider, destProvider, processorOptions)
                .then((tickets) => {
                    fs.readFile(path.join(nconf.get('DROPLOCATION'), 'fileshareWithMultipleFiles/folder1/file2.txt'), 'utf8', function (err, data) {
                        if (err) {
                            throw err;
                        }
                        assert.equal(data, "dummyFolderContent");
                        done();
                    });

                    assert.equal(tickets.find(x => x.artifactItem.path == path.join("fileshareWithMultipleFiles", "file1.pdb")).retryCount, 0);
                    assert.equal(tickets.find(x => x.artifactItem.path == path.join("fileshareWithMultipleFiles", "folder1", "file2.txt")).retryCount, 0);
                }, (error) => {
                    throw error;
                });
        });

        var runWindowsBasedTest = process.platform == 'win32' ? it : it.skip;
        runWindowsBasedTest('should be able to incrementally download the build artifact from fileshare', function (done) {
            this.timeout(15000);
            let processor = new engine.ArtifactEngine();

            let processorOptions = new engine.ArtifactEngineOptions();
            processorOptions.itemPattern = "fileshareWithMultipleFiles\\**";
            processorOptions.artifactCacheHashKey = "default_Collection.123.2048.artifactName";
            processorOptions.artifactCacheDirectory = path.join(nconf.get('CACHE'));
            processorOptions.enableIncrementalDownload = true;
            processorOptions.parallelProcessingLimit = 8;
            processorOptions.retryIntervalInSeconds = 2;
            processorOptions.retryLimit = 2;
            processorOptions.verbose = true;

            var itemsUrl1 = "C:/TestData/Old";
            var itemsUrl2 = "C:/TestData/New";
            var variables = {};
            var sourceProvider1 = new providers.FilesystemProvider(itemsUrl1, "fileshareWithMultipleFiles");
            var sourceProvider2 = new providers.FilesystemProvider(itemsUrl2, "fileshareWithMultipleFiles");
            var dropLocation = path.join(nconf.get('DROPLOCATION'));
            var destProvider1 = new providers.FilesystemProvider(dropLocation, "fileshareWithMultipleFiles");
            var destProvider2 = new providers.FilesystemProvider(dropLocation, "fileshareWithMultipleFiles");

            processor.processItems(sourceProvider1, destProvider1, processorOptions)
                .then((tick) => {
                    processor.processItems(sourceProvider2, destProvider2, processorOptions)
                        .then((tickets) => {
                            tickets.forEach((ticket) => {
                                if (ticket.artifactItem.itemType !== models.ItemType.Folder) {
                                    if (path.normalize(ticket.artifactItem.path) === "fileshareWithMultipleFiles\\File4.txt") {
                                        assert.equal(true, ticket.downloadedFromCache)
                                        done();
                                    }
                                    else if (path.normalize(ticket.artifactItem.path) === "fileshareWithMultipleFiles\\File3.txt") {
                                        done(new Error("File3 was downloaded."));
                                    }
                                    else if (path.normalize(ticket.artifactItem.path) === "fileshareWithMultipleFiles\\Folder1\\File1.txt") {
                                        assert.equal(false, ticket.downloadedFromCache)
                                    }
                                    else if (path.normalize(ticket.artifactItem.path) === "fileshareWithMultipleFiles\\Folder1\\File2.txt") {
                                        assert.equal(false, ticket.downloadedFromCache)
                                    }
                                    else {
                                        assert.equal(false, ticket.downloadedFromCache);
                                    }
                                }
                            });
                        });
                }, (error) => {
                    throw error;
                });
        });
    });
});