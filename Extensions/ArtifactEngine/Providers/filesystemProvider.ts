import * as path from 'path';
import * as fs from 'fs';
var crypto = require('crypto');

import * as models from '../Models';
import { Logger } from '../Engine/logger';
import { ArtifactItemStore } from '../Store/artifactItemStore';

var tl = require('vsts-task-lib/task');

export class FilesystemProvider implements models.IArtifactProvider {

    public artifactItemStore: ArtifactItemStore;

    constructor(rootLocation: string, rootItemPath?: string) {
        this._rootLocation = rootLocation;
        this._rootItemPath = rootItemPath ? rootItemPath : '';
        this._directoryCleanedFlag = false;
    }

    getRootItems(): Promise<models.ArtifactItem[]> {
        var rootItem = new models.ArtifactItem();
        rootItem.metadata = { downloadUrl: this._rootLocation };
        rootItem.path = this._rootItemPath;
        rootItem.itemType = models.ItemType.Folder;
        return Promise.resolve([rootItem]);
    }

    getArtifactItems(artifactItem: models.ArtifactItem): Promise<models.ArtifactItem[]> {
        var itemsPath = artifactItem.metadata["downloadUrl"];
        return this.getItems(itemsPath, artifactItem.path);
    }

    getArtifactItem(artifactItem: models.ArtifactItem): Promise<NodeJS.ReadableStream> {
        var promise = new Promise<NodeJS.ReadableStream>((resolve, reject) => {
            var itemPath: string = artifactItem.metadata['downloadUrl'];
            try {
                var contentStream = fs.createReadStream(itemPath);
                contentStream.on('end', () => {
                    this.artifactItemStore.updateDownloadSize(artifactItem, contentStream.bytesRead);
                });
                contentStream.on("error",
                    (error) => {
                        reject(error);
                    });
                resolve(contentStream);
            } catch (error) {
                reject(error);
            }
        });

        return promise;
    }

    public putArtifactItem(item: models.ArtifactItem, stream: NodeJS.ReadableStream): Promise<models.ArtifactItem> {
        return new Promise((resolve, reject) => {
            if (!this._directoryCleanedFlag) {
                if (fs.existsSync(path.join(this._rootLocation, this._rootItemPath))) {
                    tl.rmRF(path.join(this._rootLocation, this._rootItemPath));
                }
                this._directoryCleanedFlag = true;
            }

            // create parent folder if it has not already been created
            const outputFilename = path.join(this._rootLocation, item.path);
            const folder = path.dirname(outputFilename);
            try {
                tl.mkdirP(folder);
                Logger.logMessage(tl.loc("DownloadingTo", item.path, outputFilename));
                var hash = "";
                var hashInterface = crypto.createHash('sha256');
                const outputStream = fs.createWriteStream(outputFilename);
                stream.on('data', function (data) {
                    outputStream.write(data);
                    outputStream.on('error', (err) => {
                        reject(err);
                    });
                    hashInterface.update(data, 'utf8');
                });
                stream.on("end",
                    () => {
                        Logger.logMessage(tl.loc("DownloadedTo", item.path, outputFilename));
                        if (!item.metadata) {
                            item.metadata = {};
                        }
                        hash = hashInterface.digest('hex').toUpperCase();
                        item.downloadedFileHash = hash;
                        outputStream.end();
                        item.metadata[models.Constants.DestinationUrlKey] = outputFilename;
                    });
                stream.on("error",
                    (error) => {
                        reject(error);
                    });
                outputStream.on("finish", () => {
                    this.artifactItemStore.updateFileSize(item, outputStream.bytesWritten);
                    resolve(item);
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }

    public getRootLocation(): string {
        return this._rootLocation;
    }

    public getRootItemPath(): string {
        return this._rootItemPath ? this._rootItemPath : '';
    }

    dispose(): void {
    }

    private getItems(itemsPath: string, parentRelativePath?: string): Promise<models.ArtifactItem[]> {
        var promise = new Promise<models.ArtifactItem[]>((resolve, reject) => {
            var items: models.ArtifactItem[] = [];
            fs.readdir(itemsPath, (error, files) => {
                if (!!error) {
                    Logger.logMessage(tl.loc("UnableToReadDirectory", itemsPath, error));
                    reject(error);
                    return;
                }

                for (var index = 0; index < files.length; index++) {
                    var file = files[index];
                    var filePath = path.join(itemsPath, file);

                    // do not follow symbolic link
                    var itemStat;
                    try {
                        itemStat = fs.lstatSync(filePath);
                    } catch (error) {
                        reject(error);
                        return;
                    }

                    var item: models.ArtifactItem = <models.ArtifactItem>{
                        itemType: itemStat.isFile() ? models.ItemType.File : models.ItemType.Folder,
                        path: parentRelativePath ? path.join(parentRelativePath, file) : file,
                        fileLength: itemStat.size,
                        downloadedFileHash: "",
                        fileHashInArtifactMetadata: "",
                        lastModified: itemStat.mtime,
                        metadata: { "downloadUrl": filePath }
                    }

                    items = items.concat(item);
                }

                resolve(items);
            });
        });

        return promise;
    }

    private _rootLocation: string;
    private _rootItemPath: string;
    private _directoryCleanedFlag: boolean;
}