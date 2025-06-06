const { ipcRenderer } = require('electron');
const { main: debug } = require('../utils/logger');
const path = require('path');

class SyncApp {
    constructor() {
        this.syncItems = [];
        this.currentProjectId = null;
        this.isWatching = false;
        this.domElements = {
            addItemsButton: document.getElementById('add-items'),
            toggleSyncButton: document.getElementById('toggle-sync'),
            itemTree: document.getElementById('item-tree'),
            console: document.getElementById('console'),
            statusLine: document.getElementById('status-line')
        };
        this.syncStatuses = new Map();
        this.queuedFiles = 0;
        this.collapsedFolders = new Set();
        this.initializeApp();
        this.setupIpcListeners();
    }

    updateItemStatus(filePath, status) {
        const item = this.domElements.itemTree.querySelector(`[data-path="${filePath}"]`);
        if (item) {
            const statusSpan = item.querySelector('.sync-status');
            if (statusSpan) {
                statusSpan.className = `sync-status ${status}`;
                statusSpan.outerHTML = this.getSyncStatusIcon(status);
            }
        }
    }

    updateStatusLine() {
        let status;
        if (this.queuedFiles > 0) {
            status = `Syncing... ${this.queuedFiles} file(s) remaining`;
        } else if (this.isWatching) {
            status = 'All files synced. Watching for changes...';
        } else {
            status = 'Sync stopped';
        }
        this.domElements.statusLine.textContent = status;
    }

    setupIpcListeners() {
        ipcRenderer.on('file-change', (_, data) => {
            console.log('Received file-change event:', data);
            this.addConsoleEntry(data.type, `${data.type.charAt(0).toUpperCase() + data.type.slice(1)}: ${data.path}`);
        });

        ipcRenderer.on('sync-status-update', (_, data) => {
            this.updateSyncStatus(data.filePath, data.status);
        });

        ipcRenderer.on('sync-error', (_, error) => {
            console.error('Received sync-error event:', error);
            this.addConsoleEntry('error', `Sync error: ${error}`);
        });

        ipcRenderer.on('watcher-ready', () => {
            console.log('Received watcher-ready event');
            this.addConsoleEntry('info', 'File watcher is ready');
            this.updateStatusLine();
        });

        ipcRenderer.on('sync-error', (_, error) => {
            console.error('Received sync-error event:', error);
            this.addConsoleEntry('error', `Sync error: ${error}`);
        });
    }

    async initializeApp() {
        await this.loadCurrentProject();
        await this.loadSyncItems();
        this.setupEventListeners();
        this.updateItemTree();
    }

    // Load the current project ID from the main process
    async loadCurrentProject() {
        this.currentProjectId = await ipcRenderer.invoke('get-current-project');
    }

    // Load sync items for the current project
    async loadSyncItems() {
        try {
            this.syncItems = await ipcRenderer.invoke('get-sync-items');
        } catch (error) {
            console.error('Error loading sync items:', error);
            this.addConsoleEntry('error', 'Error loading sync items');
        }
    }

    // Set up event listeners for IPC and DOM events
    setupEventListeners() {
        // Listen for project changes from the main process
        ipcRenderer.on('project-changed', async (_, projectId) => {
            console.log('Received project-changed event:', projectId);
            this.currentProjectId = projectId;
            await this.loadSyncItems();
            this.updateItemTree();
        });

        // DOM event listeners
        this.domElements.addItemsButton.addEventListener('click', () => this.handleAddItems());
        this.domElements.toggleSyncButton.addEventListener('click', () => this.handleToggleSync());
    }

    async saveSyncItems() {
        try {
            console.log('Saving sync items:', this.syncItems);
            await ipcRenderer.invoke('save-sync-items', this.syncItems);
            this.addConsoleEntry('success', 'Sync items saved successfully');
        } catch (error) {
            console.error('Error saving sync items:', error);
            this.addConsoleEntry('error', 'Error saving sync items: ' + error.message);
        }
    }

    updateSyncStatus(filePath, status) {
        this.syncStatuses.set(filePath, status);
        this.updateParentStatuses(filePath, status);
        this.updateItemStatus(filePath, status);
        if (status === 'queued') {
            this.queuedFiles++;
        } else if (status === 'synced' || status === 'error') {
            this.queuedFiles = Math.max(0, this.queuedFiles - 1);
        }
        this.updateStatusLine();
    }

    updateParentStatuses(filePath, status) {
        const parts = filePath.split('/');
        while (parts.length > 1) {
            parts.pop();
            const parentPath = parts.join('/');
            const parentStatus = this.getHighestPriorityStatus(parentPath);
            this.syncStatuses.set(parentPath, parentStatus);
            this.updateItemStatus(parentPath, parentStatus);
        }
    }

    getHighestPriorityStatus(dirPath) {
        const statusPriority = ['error', 'syncing', 'queued', 'synced'];
        let highestStatus = 'synced';

        for (const [path, status] of this.syncStatuses.entries()) {
            if (path.startsWith(dirPath + '/')) {
                const priority = statusPriority.indexOf(status);
                const highestPriority = statusPriority.indexOf(highestStatus);
                if (priority < highestPriority) {
                    highestStatus = status;
                }
            }
        }

        return highestStatus;
    }

    getSyncStatusIcon(status) {
        switch (status) {
            case 'queued':
                return '<span class="sync-status queued">🕒</span>';
            case 'syncing':
                return '<span class="sync-status syncing">↻</span>';
            case 'synced':
                return '<span class="sync-status synced">✓</span>';
            case 'error':
                return '<span class="sync-status error">❌</span>';
            default:
                return '';
        }
    }

    setItemIgnored(filePath, ignored) {
        if (ignored) {
            ipcRenderer.send('delete-remote-file', filePath);
        }
        const updateIgnoreStatus = (items) => {
            for (let i = 0; i < items.length; i++) {
                if (items[i].path === filePath) {
                    items[i].ignored = ignored;
                    if (ignored) {
                        items[i].ignoreReason = 'manual';
                    } else {
                        delete items[i].ignoreReason;
                    }

                    // Si c'est un dossier, propager l'état aux enfants
                    if (items[i].isDirectory && items[i].children) {
                        this.propagateIgnoreStatus(items[i].children, ignored);
                    }
                    return true;
                }
                if (items[i].isDirectory && items[i].children) {
                    if (updateIgnoreStatus(items[i].children)) {
                        return true;
                    }
                }
            }
            return false;
        };

        updateIgnoreStatus(this.syncItems);
    }

    createTreeItem(item, parentPath = '', parentIgnored = false) {
        const fullPath = parentPath ? `${parentPath}${path.sep}${item.name}` : item.path;
        const isIgnored = parentIgnored || item.ignored;

        const div = document.createElement('div');
        div.className = `tree-item ${isIgnored ? 'ignored' : ''}`;
        div.setAttribute('data-path', fullPath);

        const status = this.syncStatuses.get(fullPath) || 'synced';

        if (item.isDirectory && isIgnored) {
            this.collapsedFolders.add(fullPath);
        }

        const isCollapsed = this.collapsedFolders.has(fullPath);

        const content = `
        <span class="${item.isDirectory ? 'folder' : 'file'} ${isIgnored ? 'ignored' : ''}">
            ${item.isDirectory ? '<span class="expander">' + (isCollapsed ? '▶' : '▼') + '</span>' : ''}
            ${item.name}
            ${isIgnored ? '<span class="ignore-toggle" data-path="' + fullPath + '">+</span>' : ''}
            ${!isIgnored ? this.getSyncStatusIcon(status) : ''}
        </span>
        ${!isIgnored ? '<span class="remove-btn" data-path="' + fullPath + '">✕</span>' : ''}
    `;
        div.innerHTML = content;

        if (item.isDirectory && item.children) {
            div.classList.toggle('collapsed', isCollapsed);

            const ul = document.createElement('ul');
            ul.style.display = isCollapsed ? 'none' : 'block';
            item.children.forEach(child => ul.appendChild(this.createTreeItem(child, fullPath, isIgnored)));
            div.appendChild(ul);
        }

        return div;
    }

    includeIgnoredFile(filePath) {
        ipcRenderer.send('upload-file', filePath);
        const findAndInclude = (items, parentPath = null) => {
            for (let i = 0; i < items.length; i++) {
                if (items[i].path === filePath) {
                    items[i].ignored = false;
                    delete items[i].ignoreReason;

                    if (items[i].isDirectory && items[i].children) {
                        this.propagateIgnoreStatus(items[i].children, false);
                    }

                    if (parentPath) {
                        // this.checkAndUpdateParentIgnoreStatus(parentPath);
                    }

                    return true;
                }

                if (items[i].isDirectory && items[i].children) {
                    if (findAndInclude(items[i].children, items[i].path)) {
                        return true;
                    }
                }
            }
            return false;
        };

        findAndInclude(this.syncItems);
    }

    hasIncludedFiles(children) {
        if (!children || children.length === 0) return false;

        for (const child of children) {
            if (!child.ignored) return true;
            if (child.isDirectory && child.children && this.hasIncludedFiles(child.children)) {
                return true;
            }
        }

        return false;
    }

    updateItemTree() {
        console.log('Updating item tree with:', this.syncItems);
        this.domElements.itemTree.innerHTML = '';
        this.syncItems.forEach(item => {
            this.domElements.itemTree.appendChild(this.createTreeItem(item));
        });
        this.addTreeItemListeners();
    }

    propagateIgnoreStatus(items, ignored) {
        for (let i = 0; i < items.length; i++) {
            items[i].ignored = ignored;
            if (ignored) {
                items[i].ignoreReason = 'parent_ignored';
            } else {
                delete items[i].ignoreReason;
            }

            if (items[i].isDirectory && items[i].children) {
                this.propagateIgnoreStatus(items[i].children, ignored);
            }
        }
    }

    // Add event listeners to tree items
    addTreeItemListeners() {
        this.domElements.itemTree.querySelectorAll('.remove-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const pathToIgnore = e.target.getAttribute('data-path');
                this.setItemIgnored(pathToIgnore, true); // Au lieu de removeItemByPath
                this.updateItemTree();
                this.saveSyncItems();
            });
        });

        this.domElements.itemTree.querySelectorAll('.expander').forEach(expander => {
            expander.addEventListener('click', (e) => {
                e.stopPropagation();
                const treeItem = e.target.closest('.tree-item');
                const fullPath = treeItem.getAttribute('data-path');
                treeItem.classList.toggle('collapsed');
                e.target.textContent = treeItem.classList.contains('collapsed') ? '▶' : '▼';
                const childrenContainer = treeItem.querySelector('ul');
                if (childrenContainer) {
                    childrenContainer.style.display = treeItem.classList.contains('collapsed') ? 'none' : 'block';
                }

                if (treeItem.classList.contains('collapsed')) {
                    this.collapsedFolders.add(fullPath);
                } else {
                    this.collapsedFolders.delete(fullPath);
                }
            });
        });

        this.domElements.itemTree.querySelectorAll('.ignore-toggle').forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const pathToInclude = e.target.getAttribute('data-path');
                this.includeIgnoredFile(pathToInclude);
                this.updateItemTree();
                this.saveSyncItems();
            });
        });
    }

    // Remove an item from syncItems by its path
    removeItemByPath(pathToRemove) {
        const removeFromArray = (items) => {
            for (let i = 0; i < items.length; i++) {
                if (items[i].path === pathToRemove) {
                    items.splice(i, 1);
                    return true;
                }
                if (items[i].isDirectory && items[i].children) {
                    if (removeFromArray(items[i].children)) {
                        return true;
                    }
                }
            }
            return false;
        };

        removeFromArray(this.syncItems);
        this.saveSyncItems();
        ipcRenderer.send('save-sync-items', this.syncItems);
    }

    async handleAddItems() {
        try {
            const result = await ipcRenderer.invoke('select-files-and-folders', this.syncItems);
            console.log('Received updated sync items:', result);
            this.syncItems = result;
            this.updateItemTree();
            await this.saveSyncItems();
        } catch (error) {
            console.error('Error adding items:', error);
            this.addConsoleEntry('error', 'Error adding items: ' + error.message);
        }
    }

    // Handle toggling sync
    handleToggleSync() {
        console.log('Toggle sync button clicked');
        if (this.isWatching) {
            console.log('Stopping sync');
            ipcRenderer.send('stop-sync');
        } else {
            console.log('Starting sync');
            const itemsToSync = this.getAllPaths(this.syncItems);
            console.log('Items to sync:', itemsToSync);
            ipcRenderer.send('start-sync', itemsToSync);
        }
        this.isWatching = !this.isWatching;
        this.domElements.toggleSyncButton.textContent = this.isWatching ? 'Stop Synchronization' : 'Start Synchronization';
        this.addConsoleEntry('info', this.isWatching ? 'Synchronization started' : 'Synchronization stopped');
        this.updateStatusLine();
    }

    // Get all paths from syncItems
    getAllPaths(items) {
        return items.reduce((acc, item) => {
            if (!item.ignored) {
                acc.push(item.path);
                if (item.isDirectory && item.children) {
                    acc.push(...this.getAllPaths(item.children));
                }
            }
            return acc;
        }, []);
    }

    addConsoleEntry(type, message) {
        const entry = document.createElement('div');
        entry.className = `console-entry ${type}`;
        entry.textContent = message;
        this.domElements.console.appendChild(entry);
        this.domElements.console.scrollTop = this.domElements.console.scrollHeight;
    }
}

// Initialize the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new SyncApp();
});