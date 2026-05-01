// Cache for API requests - load from localStorage
let apiRequestCache = {};
try {
    const cached = localStorage.getItem('apiRequestCache');
    if (cached) {
        apiRequestCache = JSON.parse(cached);
    }
} catch (e) {
    console.error('Failed to load API cache from localStorage', e);
}

function saveApiCache() {
    try {
        localStorage.setItem('apiRequestCache', JSON.stringify(apiRequestCache));
    } catch (e) {
        console.error('Failed to save API cache to localStorage', e);
    }
}

// Convert AudioBuffer to WAV blob
function audioBufferToWav(audioBuffer) {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const bytesPerSample = bitDepth / 8;
    const channelData = [];
    
    for (let i = 0; i < numberOfChannels; i++) {
        channelData.push(audioBuffer.getChannelData(i));
    }

    const interleaved = new Float32Array(audioBuffer.length * numberOfChannels);
    let offset = 0;
    for (let i = 0; i < audioBuffer.length; i++) {
        for (let j = 0; j < numberOfChannels; j++) {
            interleaved[offset++] = channelData[j][i];
        }
    }

    // Convert float samples to PCM
    const pcm = new Int16Array(interleaved.length);
    for (let i = 0; i < interleaved.length; i++) {
        pcm[i] = Math.max(-1, Math.min(1, interleaved[i])) < 0 
            ? interleaved[i] * 0x8000 
            : interleaved[i] * 0x7FFF;
    }

    // Create WAV file
    const wavSize = 36 + pcm.length * bytesPerSample;
    const wav = new ArrayBuffer(44 + pcm.length * bytesPerSample);
    const view = new DataView(wav);

    // WAV header
    view.setUint32(0, 0x46464952, true); // RIFF
    view.setUint32(4, wavSize, true);
    view.setUint32(8, 0x45564157, true); // WAVE
    view.setUint32(12, 0x20746d66, true); // fmt
    view.setUint32(16, 16, true); // fmt size
    view.setUint16(20, format, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numberOfChannels * bytesPerSample, true);
    view.setUint16(32, numberOfChannels * bytesPerSample, true);
    view.setUint16(34, bitDepth, true);
    view.setUint32(36, 0x61746164, true); // data
    view.setUint32(40, pcm.length * bytesPerSample, true);

    // Copy PCM data
    let index = 44;
    for (let i = 0; i < pcm.length; i++) {
        view.setInt16(index, pcm[i], true);
        index += bytesPerSample;
    }

    return new Blob([wav], { type: 'audio/wav' });
}

async function mixWikipediaAudio(titles) {
    // Get the audio metadata first to calculate total duration
    const audioUrls = [];
    const missingTitles = [];

    console.log("Searching for audio files...");

    for (const title of titles) {
        // 1. Get images/files attached to the page
        const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&limit=100&prop=images&titles=${encodeURIComponent(title)}&format=json&origin=*`;
        
        let audioFiles;
        if (apiRequestCache[apiUrl]) {
            audioFiles = apiRequestCache[apiUrl];
        } else {
            const response = await fetch(apiUrl).then(res => res.json());
            const pages = response.query.pages;
            const pageId = Object.keys(pages)[0];
            const images = pages[pageId].images;
            audioFiles = images ? images
                .filter(img => /\.(ogg|ogv|oga|wav|mp3)$/i.test(img.title))
                .map(img => img.title)
                : [];
            apiRequestCache[apiUrl] = audioFiles;
            saveApiCache();
        }

        const titleUrls = [];
        for (const fileTitle of audioFiles) {
            const fileInfoUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileTitle)}&prop=imageinfo&iiprop=url&format=json&origin=*`;
            
            let url;
            if (apiRequestCache[fileInfoUrl]) {
                url = apiRequestCache[fileInfoUrl];
            } else {
                const infoRes = await fetch(fileInfoUrl).then(res => res.json());
                const infoPages = infoRes.query.pages;
                const infoId = Object.keys(infoPages)[0];
                url = infoPages[infoId].imageinfo?.[0]?.url;
                apiRequestCache[fileInfoUrl] = url;
                saveApiCache();
            }
            if (url) {
                audioUrls.push(url);
                titleUrls.push(url);
            }
        }

        if (titleUrls.length === 0) {
            missingTitles.push(title);
        }
    }

    if (audioUrls.length === 0) {
        console.log("No audio files found.");
        return { missingTitles };
    }

    console.log(`Found ${audioUrls.length} files. Mixing...`);

    // 3. Fetch and decode all audio buffers
    const tempContext = new (window.AudioContext || window.webkitAudioContext)();
    const buffers = await Promise.all(
        audioUrls.map(url => 
            fetch(url)
                .then(res => res.arrayBuffer())
                .then(arrayBuffer => tempContext.decodeAudioData(arrayBuffer))
                .catch(err => console.error("Error decoding:", url, err))
        )
    );

    // Filter out any failed decodes
    const validBuffers = buffers.filter(Boolean);
    
    if (validBuffers.length === 0) {
        console.log("No valid audio buffers decoded.");
        return;
    }

    // Calculate max duration
    const maxDuration = Math.max(...validBuffers.map(b => b.duration));
    const sampleRate = validBuffers[0].sampleRate;

    // Create OfflineAudioContext with the calculated duration
    const offlineContext = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        2, // stereo
        sampleRate * maxDuration,
        sampleRate
    );

    // 4. Create sources and mix them in offline context
    validBuffers.forEach(buffer => {
        const source = offlineContext.createBufferSource();
        source.buffer = buffer;
        source.connect(offlineContext.destination);
        source.start(0);
    });

    // 5. Render the offline audio
    const renderedBuffer = await offlineContext.startRendering();
    
    return { buffer: renderedBuffer, duration: maxDuration, sampleRate, missingTitles };
}


let updatingUrl = false;
function updateUrl() {
    clearTimeout( updateUrl );
    updatingUrl = setTimeout(() => {
        const titles = document.getElementById('instruments').value.split('\n').map((a)=>a.trim()).filter((a) => a);
        const compTitle = document.getElementById('composition-title').value;
        history.replaceState(null, null, `?titles=${titles.join('|')}&title=${compTitle}`)
    }, 500 );
}

const jam = document.querySelector('#jammer button');
let jamming = false;
const makeJam = async () => {
    if ( jamming ) {
        return;
    }
    jamming = true;
    jam.textContent = 'Jamming...';
    const titles = document.getElementById('instruments').value.split('\n').map((a)=>a.trim()).filter((a) => a);
    const title = document.querySelector('#jammer input').value || 'Untitled Composition';
    document.querySelector('.composition-title').textContent = title;
    const result = await mixWikipediaAudio(titles);
    const report = document.getElementById('no-audio-report');
    if (result?.missingTitles?.length) {
        report.style.display = 'block';
        report.innerHTML = `The following Wikipedia articles didn't have associated audio files: ${result.missingTitles.map(title => `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}" target="_blank" rel="noopener">${title}</a>`).join(' ')}`;
    } else {
        report.style.display = 'none';
        report.textContent = '';
    }

    if (result?.buffer) {
        const { buffer, duration, sampleRate } = result;
        
        // Convert to WAV and create download link
        const wav = audioBufferToWav(buffer);
        const blobUrl = URL.createObjectURL(wav);
        const downloadLink = document.getElementById('download-jam');
        downloadLink.href = blobUrl;
        downloadLink.download = (title || 'composition') + '.wav';
        downloadLink.style.display = 'inline-block';
        
        // Create audio element for playback
        const audioElement = document.getElementById('composition');
        audioElement.src = blobUrl;
        
        // Also save to localStorage
        const reader = new FileReader();
        reader.readAsDataURL(wav);
    } else {
        document.getElementById('download-jam').style.display = 'none';
    }

    jam.textContent = 'Jam!';
    document.getElementById('your-jam').style.display = result?.buffer ? 'block' : 'none';
    updateUrl();
    jamming = false;
};
jam.addEventListener('click', async (ev) => {
    ev.preventDefault();
    makeJam();
});

function addSuggestionToInstruments(title) {
    const textarea = document.getElementById('instruments');
    const values = textarea.value.split('\n').map(line => line.trim()).filter(Boolean);
    if (!values.includes(title)) {
        values.push(title);
        textarea.value = values.join('\n');
        updateUrl();
    }
}

function renderSuggestionCards(pages) {
    const suggestions = document.getElementById('suggestions');
    suggestions.innerHTML = '';
    pages.forEach(page => {
        const card = document.createElement('span');
        card.className = 'cdx-card suggestion-card';
        card.tabIndex = 0;
        card.style.cursor = 'pointer';
        card.style.display = 'flex';
        card.style.alignItems = 'center';
        card.style.padding = '10px';
        card.style.marginBottom = '10px';
        card.style.gap = '10px';
        card.innerHTML = `
            ${page.thumbnail ? `<img src="${page.thumbnail.source}" alt="${page.title} thumbnail" style="width: 64px; height: 64px; object-fit: cover; border-radius: 8px;" />` : ''}
            <span class="cdx-card__text" style="flex: 1;">
                <span class="cdx-card__text__title">${page.title}</span>
                <span class="cdx-card__text__description">${page.description || 'No description available.'}</span>
            </span>
            <button type="button" class="suggestion-delete" style="background: transparent; border: none; color: #d00; font-weight: bold; cursor: pointer;">🗑️</button>
        `;
        const deleteButton = card.querySelector('.suggestion-delete');
        deleteButton.addEventListener('click', (ev) => {
            ev.stopPropagation();
            card.remove();
        });
        card.addEventListener('click', () => {
            addSuggestionToInstruments(page.title);
            card.remove();
        });
        card.addEventListener('keypress', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                card.click();
            }
        });
        suggestions.appendChild(card);
    });
}

document.getElementById('suggestClick').addEventListener('click', async () => {
    const query = document.getElementById('instruments').value.split('\n').join('|');
    const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&prop=pageimages%7Cdescription&piprop=thumbnail&pithumbsize=160&pilimit=10&generator=search&gsrsearch=morelike%3A${encodeURIComponent(query)}&gsrnamespace=0&gsrlimit=10&gsrqiprofile=classic_noboostlinks&uselang=content&smaxage=86400&maxage=86400`;
    const response = await fetch(apiUrl, { cache: 'no-store' }).then(res => res.json());
    const pages = response.query?.pages || [];
    renderSuggestionCards(pages);
});


const searcher = document.getElementById('searcher');
const searcherList = document.getElementById('searcher-list');
let searcherTimeout;
let searcherSuggestions = [];

function prependToInstruments(title) {
    const textarea = document.getElementById('instruments');
    const values = textarea.value.split('\n').map(line => line.trim()).filter(Boolean);
    if (!values.includes(title)) {
        textarea.value = [title, ...values].join('\n');
        updateUrl();
    }
}

searcher.addEventListener('input', () => {
    clearTimeout(searcherTimeout);
    const query = searcher.value.trim();
    if (!query || query.length < 2) {
        searcherList.innerHTML = '';
        return;
    }

    searcherTimeout = setTimeout(async () => {
        const apiUrl = `https://en.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(query)}&limit=10`;
        const response = await fetch(apiUrl, { cache: 'no-store' }).then(res => res.json());
        searcherSuggestions = response.pages?.map(page => page.title) || [];
        searcherList.innerHTML = searcherSuggestions.map(title => `<option value="${title}"></option>`).join('');
    }, 250);
});

searcher.addEventListener('change', () => {
    const selected = searcher.value.trim();
    if (selected && searcherSuggestions.includes(selected)) {
        prependToInstruments(selected);
        searcher.value = '';
        searcherList.innerHTML = '';
    }
});


document.getElementById('composition-title').addEventListener('input', ( ev ) => {
    document.querySelector('.cdx-card__text__title').textContent = ev.target.value;
    updateUrl();
})

// Populate textarea from URL query string
const urlParams = new URLSearchParams(window.location.search);
const titlesParam = urlParams.get('titles');
if (titlesParam) {
    const titles = titlesParam.split('|').map(title => decodeURIComponent(title));
    document.getElementById('instruments').value = titles.join('\n');
}
const ctitle = urlParams.get('title');
document.getElementById('composition-title').value = ctitle;
if ( ctitle && titlesParam ) {
    makeJam();
}
