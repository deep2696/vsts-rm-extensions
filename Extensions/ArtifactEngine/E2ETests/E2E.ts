﻿import * as assert from 'assert';
import * as path from 'path'
import * as fs from 'fs'

import * as models from "../Models"
import * as engine from "../Engine"
import * as providers from "../Providers"

import { BasicCredentialHandler } from "../Providers/typed-rest-client/handlers/basiccreds";
import { PersonalAccessTokenCredentialHandler } from "../Providers/typed-rest-client/handlers/personalaccesstoken";
import { ArtifactItemStore } from '../Store/artifactItemStore';
import { TicketState } from '../Models/ticketState';
import { ItemType } from '../Models/itemType';

var nconf = require('nconf');

nconf.argv()
    .env()
    .file(__dirname + '/../test.config.json');

describe('e2e tests', () => {
    it('should be able to download jenkins artifact', function (done) {
        this.timeout(15000);
        let processor = new engine.ArtifactEngine();

        let processorOptions = new engine.ArtifactEngineOptions();
        processorOptions.itemPattern = "**";
        processorOptions.parallelProcessingLimit = 8;
        processorOptions.retryIntervalInSeconds = 2;
        processorOptions.retryLimit = 2;
        processorOptions.verbose = true;

        var itemsUrl = "http://rmcdpjenkins2.southindia.cloudapp.azure.com:8080/job/ReleaseManagement/job/RMCDP/job/ArtifactEngineTests/job/SmallProject/10/api/json?tree=artifacts[*]";
        var variables = {
            "endpoint": {
                "url": "http://rmcdpjenkins2.southindia.cloudapp.azure.com:8080"
            },
            "definition": "ReleaseManagement/job/RMCDP/job/ArtifactEngineTests/job/SmallProject",
            "version": "10"
        };

        var handler = new BasicCredentialHandler(nconf.get('JENKINS:USERNAME'), nconf.get('JENKINS:PASSWORD'));
        var webProvider = new providers.WebProvider(itemsUrl, "jenkins.handlebars", variables, handler, { ignoreSslError: false });
        var dropLocation = path.join(nconf.get('DROPLOCATION'), "jenkinsDropWithMultipleFiles");
        var filesystemProvider = new providers.FilesystemProvider(dropLocation);

        processor.processItems(webProvider, filesystemProvider, processorOptions)
            .then((tickets) => {
                fs.readFile(path.join(nconf.get('DROPLOCATION'), 'jenkinsDropWithMultipleFiles/Extensions/ArtifactEngine/TestData/Jenkins/folder1/file2.txt'), 'utf8', function (err, data) {
                    if (err) {
                        throw err;
                    }
                    assert.equal(data, "dummyFolderContent");
                    done();
                });

                assert.equal(tickets.find(x => x.artifactItem.path == "Extensions/ArtifactEngine/TestData/Jenkins/file1.pdb").retryCount, 0);
                assert.equal(tickets.find(x => x.artifactItem.path == "Extensions/ArtifactEngine/TestData/Jenkins/folder1/file2.txt").retryCount, 0);
            }, (error) => {
                throw error;
            });
    });

    it('should be able to download jenkins artifact as zip', function (done) {
        this.timeout(15000);
        let processor = new engine.ArtifactEngine();

        let processorOptions = new engine.ArtifactEngineOptions();
        processorOptions.itemPattern = "**";
        processorOptions.parallelProcessingLimit = 8;
        processorOptions.retryIntervalInSeconds = 2;
        processorOptions.retryLimit = 2;
        processorOptions.verbose = true;

        var itemsUrl = "http://rmcdpjenkins2.southindia.cloudapp.azure.com:8080/job/ReleaseManagement/job/RMCDP/job/ArtifactEngineTests/job/SmallProject/10/artifact/*zip*/";
        var handler = new BasicCredentialHandler(nconf.get('JENKINS:USERNAME'), nconf.get('JENKINS:PASSWORD'));
        var zipProvider = new providers.ZipProvider(itemsUrl, handler, { ignoreSslError: false });
        var dropLocation = path.join(nconf.get('DROPLOCATION'), "jenkinsDropWithMultipleFiles.zip");
        var filesystemProvider = new providers.FilesystemProvider(dropLocation);

        processor.processItems(zipProvider, filesystemProvider, processorOptions)
            .then((tickets) => {
                fs.existsSync(path.join(nconf.get('DROPLOCATION'), 'jenkinsDropWithMultipleFiles.zip'));
                assert.equal(tickets.find(x => x.artifactItem.path == "").retryCount, 0);
                assert.notEqual(tickets.find(x => x.artifactItem.path == "").fileSizeInBytes, 0);
                done();
            }, (error) => {
                throw error;
            });
    });

    it('should be able to download build artifact from vsts drop', function (done) {
        this.timeout(15000);
        let processor = new engine.ArtifactEngine();

        let processorOptions = new engine.ArtifactEngineOptions();
        processorOptions.itemPattern = "**";
        processorOptions.parallelProcessingLimit = 8;
        processorOptions.retryIntervalInSeconds = 2;
        processorOptions.retryLimit = 2;
        processorOptions.verbose = true;

        var itemsUrl = "https://testking123.visualstudio.com/_apis/resources/Containers/1898832?itemPath=Dropz&isShallow=false";
        var variables = {};

        var handler = new PersonalAccessTokenCredentialHandler(nconf.get('VSTS:PAT'));
        var webProvider = new providers.WebProvider(itemsUrl, "vsts.handlebars", variables, handler, { ignoreSslError: false });
        var dropLocation = path.join(nconf.get('DROPLOCATION'), "vstsDropWithMultipleFiles");
        var filesystemProvider = new providers.FilesystemProvider(dropLocation);

        processor.processItems(webProvider, filesystemProvider, processorOptions)
            .then((tickets) => {
                fs.readFile(path.join(nconf.get('DROPLOCATION'), 'vstsDropWithMultipleFiles/dropz/folder1/file2.txt'), 'utf8', function (err, data) {
                    if (err) {
                        throw err;
                    }
                    assert.equal(data, "dummyFolderContent");
                    done();
                });

                assert.equal(tickets.find(x => x.artifactItem.path == "dropz/file1.pdb").retryCount, 0);
                assert.equal(tickets.find(x => x.artifactItem.path == "dropz/folder1/file2.txt").retryCount, 0);
            }, (error) => {
                throw error;
            });
    });

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
    runWindowsBasedTest('deepanshu should be able to download the build artifact from fileshare', function (done) {
        this.timeout(15000);
        let processor = new engine.ArtifactEngine();

        let processorOptions = new engine.ArtifactEngineOptions();
        processorOptions.itemPattern = "fileshareWithMultipleFiles\\**";
        processorOptions.uniqueUrl = "default_Collection.123.2048.artifactName";
        processorOptions.cacheDirectory = path.join(nconf.get('CACHE'));
        processorOptions.parallelProcessingLimit = 8;
        processorOptions.retryIntervalInSeconds = 2;
        processorOptions.retryLimit = 2;
        processorOptions.verbose = true;

        var itemsUrl1 = "C:/vsts-agent/_layout/_work/9/s/fileshareWithMultipleFiles";
        var itemsUrl2 = "C:/vsts-agent/_layout/_work/10/s/fileshareWithMultipleFiles";
        var variables = {};

        var sourceProvider1 = new providers.FilesystemProvider(itemsUrl1, "fileshareWithMultipleFiles");
        var sourceProvider2 = new providers.FilesystemProvider(itemsUrl2, "fileshareWithMultipleFiles");
        var dropLocation = path.join(nconf.get('DROPLOCATION'));
        var destProvider = new providers.FilesystemProvider(dropLocation,undefined,1);


        processor.processItems(sourceProvider1, destProvider, processorOptions)
            .then((tick) => {
                processor.processItems(sourceProvider2, destProvider, processorOptions)
                    .then((tickets) => {
                        tickets.forEach((ticket) => {
                            if(ticket.artifactItem.itemType !== models.ItemType.Folder) {
                                if(ticket.artifactItem.path === "fileshareWithMultipleFiles\\File3.txt") {
                                    assert.equal(models.DownloadLocation.Cache,ticket.downloadLocation)
                                    done();
                                }
                                else if(ticket.artifactItem.path === "fileshareWithMultipleFiles\\Folder1\\File1.txt")
                                    assert.equal(models.DownloadLocation.Cache,ticket.downloadLocation)
                                else if(ticket.artifactItem.path === "fileshareWithMultipleFiles\\Folder1\\File2.txt")
                                    assert.equal(models.DownloadLocation.Source,ticket.downloadLocation)
                            }
                        });
                    });
                
                
            }, (error) => {
                throw error;
            });
    });
});