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
    const folders = ref([]);
    const photos = ref([]);
    const photoCount = ref(0);

    const selectedPhoto = ref(""); // rel path
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

    const breadcrumbParts = computed(() => (folder.value ? folder.value.split("/") : []));

    async function loadFolder(rel) {
      errorMessage.value = "";
      const res = await fetch(`/api/browse?folder=${encodeURIComponent(rel)}`);
      if (!res.ok) {
        errorMessage.value = (await res.json()).error || "failed to load folder";
        return;
      }
      const data = await res.json();
      folder.value = data.folder;
      folders.value = data.folders;
      photos.value = data.photos;
      photoCount.value = data.photoCount;
    }

    function openFolder(name) {
      const next = folder.value ? `${folder.value}/${name}` : name;
      loadFolder(next);
    }

    function goToBreadcrumb(index) {
      loadFolder(breadcrumbParts.value.slice(0, index + 1).join("/"));
    }

    function goRoot() {
      loadFolder("");
    }

    async function selectPhoto(rel) {
      selectedPhoto.value = rel;
      applyMessage.value = "";
      errorMessage.value = "";
      await refreshPreview();
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

    onMounted(async () => {
      const settings = await (await fetch("/api/settings")).json();
      Object.assign(params, settings.params);
      await loadFolder(settings.folder || "");
      if (settings.photo) {
        selectedPhoto.value = settings.photo;
        await refreshPreview();
      }
    });

    return {
      folder, folders, photos, photoCount, breadcrumbParts,
      selectedPhoto, previewUrl, previewLoading,
      applying, applyMessage, errorMessage,
      params,
      openFolder, goToBreadcrumb, goRoot,
      selectPhoto, pickRandomFromFolder,
      resetParams, applyToDisplay,
    };
  },
  template: `
    <header>
      <h1>Holiday Display Picker</h1>
      <div class="status" v-if="selectedPhoto">{{ selectedPhoto }}</div>
    </header>
    <div class="layout">
      <aside class="sidebar">
        <div class="breadcrumb">
          <button @click="goRoot">root</button>
          <template v-for="(part, i) in breadcrumbParts" :key="i">
            / <button @click="goToBreadcrumb(i)">{{ part }}</button>
          </template>
        </div>
        <div class="folder-row" v-for="f in folders" :key="f" @click="openFolder(f)">
          <span>📁 {{ f }}</span>
        </div>
        <div v-if="!folders.length" class="empty-state">no subfolders</div>
      </aside>

      <section class="main">
        <div class="grid-toolbar">
          <span class="path">{{ folder || '/' }} · {{ photoCount }} photo(s) here</span>
          <button class="secondary" v-if="photoCount" @click="pickRandomFromFolder">🎲 random from this folder</button>
        </div>
        <div class="grid" v-if="photos.length">
          <div
            v-for="p in photos"
            :key="p.rel"
            class="thumb"
            :class="{ selected: selectedPhoto === p.rel }"
            @click="selectPhoto(p.rel)"
          >
            <img :src="'/api/image?path=' + encodeURIComponent(p.rel)" loading="lazy" :alt="p.name" />
          </div>
        </div>
        <div v-else class="empty-state">no photos in this folder - drill into a subfolder</div>
      </section>

      <aside class="drawer" v-if="selectedPhoto">
        <div class="preview-frame">
          <img v-if="previewUrl" :src="previewUrl" alt="dithered preview" />
          <div class="spinner" v-if="previewLoading">rendering…</div>
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
  `,
}).mount("#app");
