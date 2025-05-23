const { ipcMain, BrowserWindow, dialog } = require('electron');
const { validate: uuidValidate } = require('uuid');
const fs = require('node:fs/promises');
const path = require('path');
const chokidar = require('chokidar');
const { getStore, getCurrentProjectId, setCurrentProjectId, getSyncItemsForProject, setSyncItemsForProject } = require('./store');
const { createMainWindow, closeLoginWindow, getMainWindow } = require('./windows');
const { shouldIgnore, checkIgnoreStatus, mergeItems } = require('../utils/file-utils');
const SyncQueue = require('../utils/SyncQueue');

let handlersSetup = false;

class IpcHandlerManager {
    constructor(apiClient) {
        this.apiClient = apiClient;
        this.watcher = null;
        this.loginState = {
            email: null,
            totpSent: false
        };
        this.syncQueue = new SyncQueue(this.syncFile.bind(this));
    }

    setupHandlers() {
        this.setupLoginHandlers();
        this.setupFileSelectionHandler();
        this.setupStateHandlers();
        this.setupSyncHandlers();
        this.setupProjectHandlers();

        ipcMain.handle('logout', () => {
            this.handleLogout();
        });
    }

    setupProjectHandlers() {
        ipcMain.handle('list-projects', async () => {
            const { organizationUUID } = this.getStoredSession();
            return await this.apiClient.listProjects(organizationUUID);
        });

        ipcMain.handle('set-project', async (_, projectId) => {
            console.log('Setting project:', projectId);
            setCurrentProjectId(projectId);
            const mainWindow = getMainWindow();
            if (mainWindow) {
                console.log('Sending project-changed event to main window');
                mainWindow.webContents.send('project-changed', projectId);
            }
            return { success: true };
        });

        ipcMain.handle('get-current-project', () => {
            return getCurrentProjectId();
        });

        ipcMain.handle('get-sync-items', () => {
            const currentProjectId = getCurrentProjectId();
            return getSyncItemsForProject(currentProjectId);
        });

        ipcMain.handle('save-sync-items', (_, items) => {
            const currentProjectId = getCurrentProjectId();
            setSyncItemsForProject(currentProjectId, items);
        });

        ipcMain.handle('confirm-project-selection', async (event, projectId) => {
            console.log('Confirming project selection:', projectId);
            setCurrentProjectId(projectId);

            const mainWindow = getMainWindow();
            if (mainWindow) {
                console.log('Sending project-changed event to main window');
                mainWindow.webContents.send('project-changed', projectId);
            } else {
                console.log('Main window not found, creating new main window');
                await createMainWindow();
            }

            const projectSelectionWindow = BrowserWindow.fromWebContents(event.sender);
            if (projectSelectionWindow) {
                projectSelectionWindow.close();
            }

            return { success: true };
        });
    }

    setupLoginHandlers() {
        ipcMain.handle('request-totp', async (_, email) => {
            try {
                const result = await this.apiClient.sendMagicLink(email);
                if (result.sent) {
                    this.loginState = { email, totpSent: true };
                    return { success: true, message: 'TOTP sent to your email address' };
                }
                return { success: false, message: 'Failed to send TOTP' };
            } catch (error) {
                console.error('Error requesting TOTP:', error);
                return { success: false, message: 'Error while requesting TOTP' };
            }
        });

        if (!ipcMain.listenerCount('verify-totp')) {
            ipcMain.handle('verify-totp', async (_, totp) => {
                try {
                    if (!this.loginState.totpSent) {
                        return {success: false, message: 'Please request a magic link first'};
                    }

                    const result = await this.apiClient.verifyMagicLink(this.loginState.email, totp);
                    console.log('Magic link verification result:', result);

                    if (!result) {
                        return {success: false, message: 'No response from server'};
                    }

                    if (result.success) {
                        const organizationUUID = result.account?.memberships?.[0]?.organization?.uuid;
                        if (!organizationUUID || !uuidValidate(organizationUUID)) {
                            console.error('Invalid or missing organization UUID in the response');
                            this.handleLogout();
                            return {success: false, message: 'Invalid organization UUID'};
                        }
                        const sessionKey = this.apiClient.getSessionKey();
                        this.storeSession(sessionKey, organizationUUID);
                        await createMainWindow();
                        closeLoginWindow();
                        this.resetLoginState();
                        return {success: true};
                    } else {
                        return {success: false, message: result.error || 'Invalid code'};
                    }
                } catch (error) {
                    console.error('Error verifying magic link:', error);
                    return {success: false, message: 'Error while verifying the magic link'};
                }
            });
        }

        ipcMain.handle('check-session', async () => {
            return await this.verifySession();
        });
    }

    setupFileSelectionHandler() {
        ipcMain.handle('select-files-and-folders', async (_, existingItems) => {
            try {
                const result = await dialog.showOpenDialog(getMainWindow(), {
                    properties: ['openFile', 'openDirectory', 'multiSelections']
                });
                if (result.canceled) {
                    return existingItems;
                } else {
                    const newItems = await this.processSelectedPaths(result.filePaths);
                    const mergedItems = mergeItems(existingItems, newItems);
                    console.log('Merged items:', mergedItems);
                    const currentProjectId = getCurrentProjectId();
                    setSyncItemsForProject(currentProjectId, mergedItems);
                    console.log('Saved sync items for project:', currentProjectId, mergedItems);
                    return mergedItems;
                }
            } catch (error) {
                console.error('File selection error:', error);
                throw error;
            }
        });
    }

    setupStateHandlers() {
        ipcMain.handle('save-state', (_, state) => {
            try {
                console.log('Saving state:', state);
                getStore().set('syncItems', state);
            } catch (error) {
                console.error('Error saving state:', error);
                throw error;
            }
        });

        ipcMain.handle('load-state', () => {
            try {
                console.log('Loading state');
                const state = getStore().get('syncItems', []);
                console.log('Loaded state:', state);
                return state;
            } catch (error) {
                console.error('Error loading state:', error);
                throw error;
            }
        });
    }

    setupSyncHandlers() {
        ipcMain.on('start-sync', (_, items) => {
            console.log('Received start-sync event with items:', items);
            this.startFileWatcher(items);
        });

        ipcMain.on('delete-remote-file', (_, filePath) => {
            this.handleFileDeletion(this.getStoredSession().organizationUUID, getCurrentProjectId(), filePath);
        });

        ipcMain.on('upload-file', (_, filePath) => {
            const { organizationUUID } = this.getStoredSession();
            const projectUUID = getCurrentProjectId();
            const rootInfo = this.getSyncRootForFile(filePath);

            if (rootInfo) {
                this.updateSyncStatus(filePath, 'queued');
                this.syncQueue.add({
                    organizationUUID,
                    projectUUID,
                    filePath,
                    syncRoot: rootInfo.syncRoot,
                    eventType: 'add'
                });
            }
        });

        ipcMain.on('stop-sync', () => {
            console.log('Received stop-sync event');
            this.stopFileWatcher();
        });
    }

    resetLoginState() {
        this.loginState = {
            email: null,
            totpSent: false
        };
    }

    async verifySession() {
        try {
            const { organizationUUID } = this.getStoredSession();
            if (!organizationUUID || !uuidValidate(organizationUUID)) {
                console.error('Invalid or missing organization UUID:', organizationUUID);
                return { success: false, message: 'Invalid organization UUID' };
            }

            const isValid = await this.apiClient.verifySession(organizationUUID);
            if (isValid) {
                return { success: true };
            } else {
                return { success: false, message: 'Session is not valid' };
            }
        } catch (error) {
            console.error('Error verifying session:', error);
            return { success: false, message: 'Error while verifying the session' };
        }
    }

    storeSession(sessionKey, organizationUUID) {
        console.log('Storing session:', { sessionKey, organizationUUID });
        if (!sessionKey) {
            console.error('Attempt to store null or undefined sessionKey');
            return;
        }
        if (!organizationUUID || !uuidValidate(organizationUUID)) {
            console.error('Invalid organization UUID:', organizationUUID);
            return;
        }
        getStore().set('sessionKey', sessionKey);
        getStore().set('organizationUUID', organizationUUID);
    }

    getStoredSession() {
        const sessionKey = getStore().get('sessionKey');
        const organizationUUID = getStore().get('organizationUUID');
        console.log('Retrieved stored session:', { sessionKey, organizationUUID });
        return { sessionKey, organizationUUID };
    }

    clearSession() {
        console.log('Clearing session');
        getStore().delete('sessionKey');
        getStore().delete('organizationUUID');
    }

    handleLogout() {
        this.clearSession();
        this.resetLoginState();
        createLoginWindow();
        if (getMainWindow()) {
            getMainWindow().close();
        }
    }

    async processSelectedPaths(filePaths) {
        return Promise.all(filePaths.map(async (filePath) => {
            const stats = await fs.stat(filePath);
            const ignoreStatus = checkIgnoreStatus(filePath);

            if (stats.isDirectory()) {
                return {
                    name: path.basename(filePath),
                    path: filePath,
                    isDirectory: true,
                    ignored: ignoreStatus.ignored,
                    ignoreReason: ignoreStatus.reason,
                    children: await this.getDirectoryContents(filePath)
                };
            } else {
                return {
                    name: path.basename(filePath),
                    path: filePath,
                    isDirectory: false,
                    ignored: ignoreStatus.ignored,
                    ignoreReason: ignoreStatus.reason
                };
            }
        })).then(items => items);
    }

    async getDirectoryContents(dir) {
        const items = await fs.readdir(dir, { withFileTypes: true });
        return Promise.all(items.map(async (item) => {
            const fullPath = path.join(dir, item.name);
            const ignoreStatus = checkIgnoreStatus(fullPath);

            if (item.isDirectory()) {
                const children = await this.getDirectoryContents(fullPath);
                return {
                    name: item.name,
                    path: fullPath,
                    isDirectory: true,
                    ignored: ignoreStatus.ignored,
                    ignoreReason: ignoreStatus.reason,
                    children: children
                };
            } else {
                return {
                    name: item.name,
                    path: fullPath,
                    isDirectory: false,
                    ignored: ignoreStatus.ignored,
                    ignoreReason: ignoreStatus.reason
                };
            }
        }));
        console.log(`Directory ${dir} contains ${results.length} items`);
    }

    getNonIgnoredPaths(items) {
        const paths = [];

        const extractPaths = (items) => {
            for (const item of items) {
                if (!item.ignored) {
                    paths.push(item.path);
                }
                if (item.isDirectory && item.children) {
                    extractPaths(item.children);
                }
            }
        };

        extractPaths(items);
        return paths;
    }

    startFileWatcher(items) {
        console.log('Starting file watcher for items:', items);
        if (this.watcher) {
            this.watcher.close();
        }

        // Vérifier que le tableau d'items est valide et non vide
        if (!items || !Array.isArray(items) || items.length === 0) {
            console.error('No valid items to watch');
            getMainWindow().webContents.send('sync-error', 'No valid items to watch');
            return;
        }

        const validPaths = items.filter(path => typeof path === 'string' && path.trim() !== '');

        if (validPaths.length === 0) {
            console.error('No valid paths to watch');
            getMainWindow().webContents.send('sync-error', 'No valid paths to watch');
            return;
        }

        console.log('Watching paths:', validPaths);

        this.watcher = chokidar.watch(validPaths, {
            ignored: shouldIgnore,
            persistent: true,
            ignoreInitial: false,
            usePolling: true,
            interval: 100,
            binaryInterval: 300,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', path => this.handleFileEvent('add', path))
            .on('change', path => this.handleFileEvent('change', path))
            .on('unlink', path => this.handleFileEvent('delete', path))
            .on('error', this.handleWatcherError.bind(this))
            .on('ready', this.handleWatcherReady.bind(this));
    }

    stopFileWatcher() {
        if (this.watcher) {
            this.watcher.close();
            getMainWindow().webContents.send('sync-stopped');
        }
    }

    handleFileEvent(eventType, filePath) {
        console.log(`File ${filePath} has been ${eventType}ed`);

        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.webContents.send('file-change', { type: eventType, path: filePath });
        }

        const { organizationUUID } = this.getStoredSession();
        const projectUUID = getCurrentProjectId();
        const rootInfo = this.getSyncRootForFile(filePath);

        if (!rootInfo) {
            console.log(`File ${filePath} is not in any sync root, ignoring.`);
            return;
        }

        const { syncRoot } = rootInfo;

        if (!this.isFileIncludedInSyncItems(filePath)) {
            console.log(`File ${filePath} is not included in sync items, ignoring.`);
            return;
        }

        if (eventType === 'unlink' || eventType === 'unlinkDir') {
            this.handleFileDeletion(organizationUUID, projectUUID, filePath);
        } else {
            this.updateSyncStatus(filePath, 'queued');
            this.syncQueue.add({ organizationUUID, projectUUID, filePath, syncRoot, eventType });
        }
    }

    async handleFileDeletion(organizationUUID, projectUUID, filePath) {
        console.log(`Handling deletion for file: ${filePath}`);

        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.webContents.send('file-change', { type: 'deleting', path: filePath });
        }

        try {
            // Get the root information for the file
            const rootInfo = this.getSyncRootForFile(filePath);
            if (!rootInfo) {
                console.log(`File ${filePath} is not in any sync root, ignoring deletion.`);
                return;
            }

            const { syncRoot } = rootInfo;
            const rootFolder = path.basename(syncRoot);
            const relativeFilePath = path.relative(syncRoot, filePath);
            const apiFileName = path.join(rootFolder, relativeFilePath).replace(/\\/g, '/');

            // List existing files in the project
            const existingFiles = await this.apiClient.listProjectFiles(organizationUUID, projectUUID);

            // Find the file to delete
            const fileToDelete = existingFiles.find(file => file.file_name === apiFileName);

            if (fileToDelete) {
                // Delete the file on the server
                await this.apiClient.deleteFile(organizationUUID, projectUUID, fileToDelete.uuid);
                console.log(`Deleted file ${apiFileName} from server`);

                this.updateSyncStatus(filePath, 'deleted');
                if (mainWindow) {
                    mainWindow.webContents.send('file-change', { type: 'deleted', path: filePath });
                }
            } else {
                console.log(`File ${apiFileName} not found on server, no deletion needed`);
            }
        } catch (error) {
            console.error(`Error deleting file ${filePath}:`, error);
            this.updateSyncStatus(filePath, 'error');
            if (mainWindow) {
                mainWindow.webContents.send('sync-error', `Error deleting ${filePath}: ${error.message}`);
            }
        }
    }

    isFileIncludedInSyncItems(filePath) {
        const currentProjectId = getCurrentProjectId();
        const syncItems = getSyncItemsForProject(currentProjectId);
        return this.isFileInItems(filePath, syncItems);
    }

    isFileInItems(filePath, items) {
        for (const item of items) {
            if (!item.isDirectory && item.path === filePath && !item.ignored) {
                return true;
            }
            if (item.isDirectory && item.children) {
                if (this.isFileInItems(filePath, item.children)) {
                    return true;
                }
            }
        }
        return false;
    }

    getSyncRootForFile(filePath) {
        const currentProjectId = getCurrentProjectId();
        const syncItems = getSyncItemsForProject(currentProjectId);

        filePath = path.normalize(filePath);

        for (const item of syncItems) {
            const itemPath = path.normalize(item.path);
            if (filePath.startsWith(itemPath)) {
                return {
                    syncRoot: item.path,
                    rootFolder: path.basename(item.path)
                };
            }
        }

        return null;
    }

    async syncFile({ organizationUUID, projectUUID, filePath, syncRoot, eventType }) {
        this.updateSyncStatus(filePath, 'syncing');
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.webContents.send('file-change', { type: 'syncing', path: filePath });
        }

        const rootFolder = path.basename(syncRoot);
        const relativeFilePath = path.relative(syncRoot, filePath);
        const apiFileName = path.join(rootFolder, relativeFilePath).replace(/\\/g, '/');

        try {
            const existingFiles = await this.apiClient.listProjectFiles(organizationUUID, projectUUID);
            const existingFile = existingFiles.find(file => file.file_name === apiFileName);

            if (eventType === 'delete') {
                if (existingFile) {
                    await this.apiClient.deleteFile(organizationUUID, projectUUID, existingFile.uuid);
                    console.log(`Deleted file ${apiFileName}`);
                }
            } else {
                if (existingFile) {
                    await this.apiClient.deleteFile(organizationUUID, projectUUID, existingFile.uuid);
                }
                await this.apiClient.uploadFile(organizationUUID, projectUUID, apiFileName, filePath);
                console.log(`Uploaded ${apiFileName}`);
            }

            this.updateSyncStatus(filePath, 'synced');
            if (mainWindow) {
                mainWindow.webContents.send('file-change', { type: 'synced', path: filePath });
            }
        } catch (error) {
            console.error(`Error syncing file ${filePath}:`, error);
            this.updateSyncStatus(filePath, 'error');
            if (mainWindow) {
                mainWindow.webContents.send('sync-error', `Error syncing ${filePath}: ${error.message}`);
            }
            throw error;
        }
    }

    updateSyncStatus(filePath, status) {
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.webContents.send('sync-status-update', { filePath, status });
        }
    }

    handleWatcherError(error) {
        console.error(`Watcher error: ${error}`);
        getMainWindow().webContents.send('sync-error', error.toString());
    }

    handleWatcherReady() {
        console.log('Initial scan complete. Ready for changes.');
        getMainWindow().webContents.send('watcher-ready');
    }
}


function setupIpcHandlers(apiClient) {
    if (handlersSetup) {
        console.log('IPC handlers already set up. Skipping...');
        return;
    }

    const handlerManager = new IpcHandlerManager(apiClient);
    handlerManager.setupHandlers();
    handlersSetup = true;
    return handlerManager;
}

module.exports = { setupIpcHandlers };