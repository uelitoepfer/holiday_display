const { createApp, reactive, ref, computed, watch, onMounted } = Vue;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

createApp({
  setup() {
    const folder = ref("");
    const allFolders = ref([]);
    const photos = ref([]);
    const photoCount = ref(0);
    const carouselIndex = ref(0);
    const showCarousel = ref(false);

    const selectedPhoto = ref(""); // rel path, once sent to the tuning drawer
    const photoOrientation = ref(""); // "landscape" | "portrait" | ""
    const previewUrl = ref("");
    const previewLoading = ref(false);
    const applying = ref(false);
    const applyMessage = ref("");
    const errorMessage = ref("");

    const params = reactive({
      brightness: 105,
      saturation: 160,
      hue: 100,
      sigmoidalContrast: 3,
      sigmoidalMidpoint: 50,
    });

    const autoShuffle = reactive({ enabled: false, folder: "", intervalMinutes: 60, orientation: "either" });
    const savingAutoShuffle = ref(false);

    const currentPhoto = computed(() => photos.value[carouselIndex.value] || null);

    // Flat paths -> an indented tree, so nested folders are visible at a
    // glance without drilling in. Alphabetical sort naturally groups every
    // "Trip A/..." entry right after "Trip A", so depth = segment count is
    // enough to indent correctly without building a real tree structure.
    const folderTree = computed(() =>
      [...allFolders.value].sort().map((path) => {
        const parts = path.split("/");
        return { path, name: parts[parts.length - 1], depth: parts.length - 1 };
      })
    );

    async function loadFolderList() {
      const res = await fetch("/api/folders");
      if (!res.ok) {
        errorMessage.value = (await res.json()).error || "failed to load folder list";
        return;
      }
      const data = await res.json();
      allFolders.value = data.folders;
    }

    async function loadFolder(rel) {
      errorMessage.value = "";
      const res = await fetch(`/api/browse?folder=${encodeURIComponent(rel)}`);
      if (!res.ok) {
        errorMessage.value = (await res.json()).error || "failed to load folder";
        return;
      }
      const data = await res.json();
      folder.value = data.folder;
      photos.value = data.photos;
      photoCount.value = data.photoCount;
      carouselIndex.value = 0;
      showCarousel.value = false;
    }

    function openCarousel(index) {
      carouselIndex.value = index;
      showCarousel.value = true;
    }

    function closeCarousel() {
      showCarousel.value = false;
    }

    function prevPhoto() {
      if (!photos.value.length) return;
      carouselIndex.value = (carouselIndex.value - 1 + photos.value.length) % photos.value.length;
    }

    function nextPhoto() {
      if (!photos.value.length) return;
      carouselIndex.value = (carouselIndex.value + 1) % photos.value.length;
    }

    async function selectPhoto(rel) {
      selectedPhoto.value = rel;
      photoOrientation.value = "";
      applyMessage.value = "";
      errorMessage.value = "";
      fetch(`/api/orientation?path=${encodeURIComponent(rel)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) photoOrientation.value = data.orientation;
        })
        .catch(() => {});
      await refreshPreview();
    }

    function tuneCurrentPhoto() {
      if (!currentPhoto.value) return;
      showCarousel.value = false;
      selectPhoto(currentPhoto.value.rel);
    }

    async function pickRandomFromFolder() {
      errorMessage.value = "";
      const res = await fetch(`/api/random-photo?folder=${encodeURIComponent(folder.value)}`);
      if (!res.ok) {
        errorMessage.value = (await res.json()).error || "no photos in this folder";
        return;
      }
      const data = await res.json();
      await selectPhoto(data.photo);
    }

    async function refreshPreview() {
      if (!selectedPhoto.value) return;
      previewLoading.value = true;
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photo: selectedPhoto.value, params: { ...params } }),
        });
        if (!res.ok) {
          errorMessage.value = (await res.json()).error || "preview failed";
          return;
        }
        const blob = await res.blob();
        if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
        previewUrl.value = URL.createObjectURL(blob);
      } finally {
        previewLoading.value = false;
      }
    }

    const debouncedPreview = debounce(refreshPreview, 250);
    watch(params, () => {
      applyMessage.value = "";
      debouncedPreview();
    });

    function resetParams() {
      Object.assign(params, {
        brightness: 105,
        saturation: 160,
        hue: 100,
        sigmoidalContrast: 3,
        sigmoidalMidpoint: 50,
      });
    }

    function closeDrawer() {
      selectedPhoto.value = "";
      photoOrientation.value = "";
      if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
      previewUrl.value = "";
    }

    async function applyToDisplay() {
      if (!selectedPhoto.value) return;
      applying.value = true;
      errorMessage.value = "";
      applyMessage.value = "";
      try {
        const res = await fetch("/api/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ photo: selectedPhoto.value, folder: folder.value, params: { ...params } }),
        });
        if (!res.ok) {
          errorMessage.value = (await res.json()).error || "apply failed";
          return;
        }
        applyMessage.value = "Sent to the display.";
      } finally {
        applying.value = false;
      }
    }

    async function saveAutoShuffle(enabled) {
      savingAutoShuffle.value = true;
      errorMessage.value = "";
      try {
        const res = await fetch("/api/auto-shuffle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            folder: folder.value,
            intervalMinutes: autoShuffle.intervalMinutes,
            orientation: autoShuffle.orientation,
            params: { ...params },
          }),
        });
        if (!res.ok) {
          errorMessage.value = (await res.json()).error || "could not update auto-shuffle";
          return;
        }
        const data = await res.json();
        Object.assign(autoShuffle, data.settings.autoShuffle);
      } finally {
        savingAutoShuffle.value = false;
      }
    }

    onMounted(async () => {
      const settings = await (await fetch("/api/settings")).json();
      Object.assign(params, settings.params);
      Object.assign(autoShuffle, settings.autoShuffle);
      await loadFolderList();
      await loadFolder(settings.folder || "");
    });

    return {
      folder, folderTree, photos, photoCount,
      carouselIndex, currentPhoto, showCarousel, openCarousel, closeCarousel, prevPhoto, nextPhoto, tuneCurrentPhoto,
      selectedPhoto, photoOrientation, previewUrl, previewLoading,
      applying, applyMessage, errorMessage,
      params, autoShuffle, savingAutoShuffle,
      loadFolder,
      selectPhoto, pickRandomFromFolder,
      resetParams, applyToDisplay, closeDrawer, saveAutoShuffle,
    };
  },
  template: `
    <header>
      <div>
        <span class="eyebrow">e-ink print picker</span>
        <h1>Holiday Display</h1>
      </div>
      <div class="palette-strip" title="Spectra 6 panel palette">
        <span class="swatch" style="--c:#000000"></span>
        <span class="swatch" style="--c:#FFFFFF"></span>
        <span class="swatch" style="--c:#FF0000"></span>
        <span class="swatch" style="--c:#FFF200"></span>
        <span class="swatch" style="--c:#0000FF"></span>
        <span class="swatch" style="--c:#00A651"></span>
      </div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <div class="folder-row" :class="{ active: folder === '' }" @click="loadFolder('')">/ (top level)</div>
        <div
          class="folder-row"
          v-for="f in folderTree"
          :key="f.path"
          :style="{ paddingLeft: (10 + f.depth * 16) + 'px' }"
          :class="{ active: folder === f.path }"
          :title="f.path"
          @click="loadFolder(f.path)"
        >{{ f.name }}</div>
      </aside>

      <section class="main">
        <div class="grid-toolbar">
          <span class="path">{{ folder || '/' }} · {{ photoCount }} photo(s) here</span>
          <button class="secondary" v-if="photoCount" @click="pickRandomFromFolder">shuffle now</button>
        </div>
        <div class="error-note main-error" v-if="errorMessage">{{ errorMessage }}</div>

        <div class="grid" v-if="photos.length">
          <div
            v-for="(p, i) in photos"
            :key="p.rel"
            class="thumb"
            @click="openCarousel(i)"
          >
            <img :src="'/api/image?path=' + encodeURIComponent(p.rel)" loading="lazy" :alt="p.name" />
          </div>
        </div>
        <div v-else class="empty-state">no photos directly in this folder - pick another from the list</div>

        <div class="auto-shuffle-bar">
          <span class="auto-shuffle-label">auto-shuffle this folder every</span>
          <input type="number" min="1" class="minutes-input" v-model.number="autoShuffle.intervalMinutes" />
          <span class="auto-shuffle-label">min</span>
          <select class="orientation-select" v-model="autoShuffle.orientation">
            <option value="either">either orientation</option>
            <option value="landscape">landscape only</option>
            <option value="portrait">portrait only</option>
          </select>
          <button
            class="secondary"
            :disabled="savingAutoShuffle || !folder"
            @click="saveAutoShuffle(!autoShuffle.enabled || autoShuffle.folder !== folder)"
          >
            {{ autoShuffle.enabled && autoShuffle.folder === folder ? 'stop' : 'start' }}
          </button>
          <span class="auto-shuffle-status" v-if="autoShuffle.enabled">
            running on "{{ autoShuffle.folder || '/' }}" every {{ autoShuffle.intervalMinutes }} min
            <template v-if="autoShuffle.orientation !== 'either'">({{ autoShuffle.orientation }} only)</template>
          </span>
        </div>
      </section>

      <aside class="drawer" v-if="selectedPhoto">
        <div class="drawer-header">
          <span class="eyebrow">tuning</span>
          <button class="close-btn" @click="closeDrawer">×</button>
        </div>
        <div class="preview-frame">
          <img v-if="previewUrl" :src="previewUrl" alt="dithered preview" />
          <div class="spinner" v-if="previewLoading">rendering…</div>
          <span class="orientation-badge" v-if="photoOrientation">{{ photoOrientation }}</span>
        </div>

        <div class="control">
          <label><span>Brightness</span><span>{{ params.brightness }}</span></label>
          <input type="range" min="60" max="150" v-model.number="params.brightness" />
        </div>
        <div class="control">
          <label><span>Saturation</span><span>{{ params.saturation }}</span></label>
          <input type="range" min="60" max="250" v-model.number="params.saturation" />
        </div>
        <div class="control">
          <label><span>Hue</span><span>{{ params.hue }}</span></label>
          <input type="range" min="60" max="140" v-model.number="params.hue" />
        </div>
        <div class="control">
          <label><span>Contrast</span><span>{{ params.sigmoidalContrast }}</span></label>
          <input type="range" min="0" max="10" step="0.5" v-model.number="params.sigmoidalContrast" />
        </div>
        <div class="control">
          <label><span>Contrast midpoint</span><span>{{ params.sigmoidalMidpoint }}%</span></label>
          <input type="range" min="20" max="80" v-model.number="params.sigmoidalMidpoint" />
        </div>
        <button class="reset-link" @click="resetParams">reset to defaults</button>

        <div class="actions">
          <button class="primary" :disabled="applying || previewLoading" @click="applyToDisplay">
            {{ applying ? 'Sending…' : 'Send to display' }}
          </button>
        </div>
        <div class="applied-note" v-if="applyMessage">{{ applyMessage }}</div>
        <div class="error-note" v-if="errorMessage">{{ errorMessage }}</div>
      </aside>
    </div>

    <div class="carousel-overlay" v-if="showCarousel && currentPhoto" @click.self="closeCarousel">
      <button class="close-btn overlay-close" @click="closeCarousel">×</button>
      <div class="carousel">
        <button class="carousel-arrow" @click="prevPhoto" :disabled="photos.length < 2">‹</button>
        <div class="carousel-frame">
          <img :src="'/api/image?path=' + encodeURIComponent(currentPhoto.rel)" :alt="currentPhoto.name" />
        </div>
        <button class="carousel-arrow" @click="nextPhoto" :disabled="photos.length < 2">›</button>
      </div>
      <div class="carousel-footer">
        <span class="carousel-count">{{ carouselIndex + 1 }} / {{ photos.length }} · {{ currentPhoto.name }}</span>
        <button class="primary" @click="tuneCurrentPhoto">Tune &amp; select</button>
      </div>
    </div>
  `,
}).mount("#app");
