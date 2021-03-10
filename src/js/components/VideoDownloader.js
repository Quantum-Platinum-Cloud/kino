import getIDBConnection from '../modules/IDBConnection.module';
import DownloadManager from './VideoDownloader/DownloadManager.module';
import StorageManager from './VideoDownloader/StorageManager.module';
import { getURLsForDownload } from './VideoDownloader/Urls.module';

const style = `
<style>
    :host,
    :host * {
        display: none;
    }
    :host( :not( [state="not-initialized"] ) ) {
        display: block;
    }
    :host( [state="ready"] ) button,
    :host( [state="unable"] ) button,
    :host( [state="partial"] ) button {
        display: block;
    }
    :host( [state="partial"] ) progress {
        display: block;
        width: 100%;
    }
    :host( [state="done"] ) span {
        display: block;
        color: green;
    }
    button {
        cursor: pointer;
    }
</style>
`;

export default class extends HTMLElement {
  static get observedAttributes() {
    return ['state', 'progress'];
  }

  constructor() {
    super();

    // Attach Shadow DOM.
    this.internal = {};
    this.internal.root = this.attachShadow({ mode: 'open' });
  }

  /**
   * After the components is attached to DOM, set up some defaults.
   */
  connectedCallback() {
    if (!this.state) this.state = 'not-initialized';
  }

  /**
   * Reflected DOM Attributes.
   *
   * @returns {string} Components state string.
   */
  get state() {
    return this.getAttribute('state');
  }

  set state(state) {
    this.setAttribute('state', state);
  }

  get progress() {
    const progress = parseFloat(this.getAttribute('progress'));
    const clampedProgress = Math.min(Math.max(0, progress), 100);

    return clampedProgress;
  }

  set progress(progress) {
    const progressFloat = parseFloat(progress);
    const clampedProgress = Math.min(Math.max(0, progressFloat), 100);

    this.setAttribute('progress', clampedProgress);
  }

  /**
   * Observed attributes callbacks.
   *
   * @param {string} name  Attribute name.
   * @param {*}      old   Previous attribute value.
   * @param {*}      value Current attribute value.
   */
  attributeChangedCallback(name, old, value) {
    if (name === 'progress') {
      this.internal.elements.progress.value = value;
    }
  }

  /**
   * Component logic.
   *
   * @param {object} apiData   Video data coming from the API.
   * @param {string} cacheName Cache name.
   */
  init(apiData, cacheName = 'v1') {
    this.internal = {
      ...this.internal,
      apiData,
      cacheName,
      elements: {},
    };

    const videoId = this.getId();
    const sources = this.internal.apiData['video-sources'] || [];

    getURLsForDownload(videoId, sources).then(async (files) => {
      const db = await getIDBConnection();
      const dbFiles = await db.file.getByVideoId(videoId);
      const dbFilesUrlTuples = dbFiles.map((fileMeta) => [fileMeta.url, fileMeta]);
      const dbFilesByUrl = Object.fromEntries(dbFilesUrlTuples);

      /**
       * If we have an entry for this file in the database, use it. Otherwise
       * fall back to the freshly generated FileMeta object.
       */
      const filesWithStateUpdatedFromDb = files.map(
        (fileMeta) => (dbFilesByUrl[fileMeta.url] ? dbFilesByUrl[fileMeta.url] : fileMeta),
      );

      this.setMeta(await db.meta.get(videoId));
      this.internal.files = filesWithStateUpdatedFromDb;

      this.render();
    });
  }

  /**
   * Returns the thumbnail image URLs.
   *
   * @returns {string[]} URLs.
   */
  getPosterURLs() {
    const urls = [];
    if (Array.isArray(this.internal.apiData.thumbnail)) {
      this.internal.apiData.thumbnail.forEach((thumbnail) => urls.push(thumbnail.src));
    } else {
      urls.push(this.internal.apiData.thumbnail);
    }
    return urls;
  }

  /**
   * Returns the subtitles URLs.
   *
   * @returns {string[]} URLs.
   */
  getSubtitlesUrls() {
    const subtitlesObjects = this.internal.apiData['video-subtitles'] || [];
    const subtitlesUrls = subtitlesObjects.map((subObject) => subObject.src);

    return subtitlesUrls;
  }

  /**
   * Saves assets to the specified cache using Cache API.
   *
   * @param {string[]} urls Array of URLs to be saved to the cache.
   *
   * @returns {Promise} Resolves when the assets are stored in the cache.
   */
  async saveToCache(urls) {
    const cache = await caches.open(this.internal.cacheName);
    return cache.addAll(urls);
  }

  /**
   * Downloads the current video and its assets to the cache and IDB.
   */
  async download() {
    const posterURLs = this.getPosterURLs();
    const subtitlesURLs = this.getSubtitlesUrls();

    this.saveToCache([...posterURLs, ...subtitlesURLs]);
    this.runIDBDownloads();
  }

  /**
   * Returns the total download progress for the video.
   *
   * @returns {number} Percentage progress for the video in the range 0–100.
   */
  getProgress() {
    const pieceValue = 1 / this.internal.files.length;
    const percentageProgress = this.internal.files.reduce(
      (percentage, fileMeta) => {
        if (fileMeta.done) {
          percentage += pieceValue;
        } else if (fileMeta.bytesDownloaded === 0 || !fileMeta.bytesTotal) {
          percentage += 0;
        } else {
          const percentageOfCurrent = fileMeta.bytesDownloaded / fileMeta.bytesTotal;
          percentage += percentageOfCurrent * pieceValue;
        }
        return percentage;
      },
      0,
    );
    const clampedPercents = Math.max(0, Math.min(percentageProgress, 100));

    return clampedPercents;
  }

  /**
   * Takes a list of video URLs, downloads the video using a stream reader
   * and invokes `storeVideoChunk` to store individual video chunks in IndexedDB.
   */
  async runIDBDownloads() {
    this.downloadManager = new DownloadManager(this);
    this.storageManager = new StorageManager(this);

    this.storageManager.onprogress = (progress) => {
      this.progress = progress;
    };
    this.storageManager.ondone = () => {
      this.progress = 100;
      this.state = 'done';
    };

    /**
     * The `DownloadManager` instance will download all remaining files in sequence and will
     * emit data chunks along the way.
     *
     * We subscribe the `StoreManager` instance to the `onflush` event of the `DownloadManager`
     * to make sure all chunks are sent to the `storeChunk` method of the `StoreManager`.
     */
    const boundStoreChunkHandler = this.storageManager.storeChunk.bind(this.storageManager);
    this.downloadManager.onflush = boundStoreChunkHandler;

    this.state = 'partial';
    this.downloadManager.run();
  }

  /**
   * Renders the UI.
   *
   * @returns {void}
   */
  render() {
    const templateElement = document.createElement('template');
    templateElement.innerHTML = `${style}
            <button>Download for Offline playback</button>
            <span>✔ Ready for offline playback.</span>
            <progress max="1" value="0"></progress>`;

    while (this.internal.root.firstChild) {
      this.internal.root.removeChild(this.internal.root.firstChild);
    }

    const ui = templateElement.content.cloneNode(true);
    this.internal.root.appendChild(ui);

    this.internal.elements.progress = this.internal.root.querySelector('progress');
    this.internal.elements.button = this.internal.root.querySelector('button');
    this.internal.elements.button.addEventListener('click', this.download.bind(this));

    this.setDownloadState();
  }

  /**
   * @returns {VideoMeta} Video meta value.
   */
  getMeta() {
    return this.internal.meta || {};
  }

  /**
   * @param {VideoMeta} meta Video meta value.
   */
  setMeta(meta) {
    this.internal.meta = meta;
  }

  /**
   * Returns the associated video ID.
   *
   * @returns {string} Video ID.
   */
  getId() {
    return this.internal.apiData?.id || '';
  }

  /**
   * Retrieve information about video download state and update
   * component's `state` and `progress` attribute values.
   */
  async setDownloadState() {
    this.internal.elements.button.disabled = false;

    const videoMeta = this.getMeta();
    const downloadProgress = this.getProgress();

    if (videoMeta.done) {
      this.state = 'done';
    } else if (downloadProgress) {
      this.state = 'partial';
      this.progress = downloadProgress;
      this.internal.elements.button.innerHTML = 'Resume Download';
    } else {
      this.state = 'ready';
    }
  }
}
