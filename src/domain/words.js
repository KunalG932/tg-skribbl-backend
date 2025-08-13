let cachedWords = [
  'cat', 'dog', 'house', 'car', 'tree', 'phone', 'pizza', 'guitar', 'rocket', 'flower',
  'computer', 'book', 'chair', 'bottle', 'mountain', 'river', 'sun', 'moon', 'star', 'cloud',
  'elephant', 'butterfly', 'airplane', 'bicycle', 'sandwich', 'umbrella', 'camera', 'lighthouse',
  'dragon', 'castle', 'rainbow', 'pencil', 'hammer', 'crown', 'bridge', 'robot', 'diamond',
  'whale', 'octopus', 'mushroom', 'volcano', 'treasure', 'feather', 'snowman', 'windmill',
  'telescope', 'compass', 'trophy', 'violin', 'butterfly', 'sailboat', 'pyramid', 'jungle'
];

let isLoadingWords = false;
let lastFetchTime = 0;
const FETCH_COOLDOWN = 300000; // 5 minutes

const API_ENDPOINTS = [
  {
    name: 'random-word-api',
    url: 'https://random-word-api.vercel.app/api?words=20',
    transform: (data) => Array.isArray(data) ? data.filter(word => word && word.length >= 3 && word.length <= 12) : []
  },
  {
    name: 'api-ninjas',
    url: 'https://api.api-ninjas.com/v1/randomword',
    transform: (data) => data?.word && data.word.length >= 3 && data.word.length <= 12 ? [data.word] : []
  },
  {
    name: 'random-word-herokuapp',
    url: 'https://random-word-api.herokuapp.com/word',
    transform: (data) => Array.isArray(data) && data[0] && data[0].length >= 3 && data[0].length <= 12 ? [data[0]] : []
  }
];

async function fetchWordsFromAPI(endpoint) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(endpoint.url, {
      signal: controller.signal,
      headers: endpoint.name === 'api-ninjas' ? { 'X-Api-Key': process.env.API_NINJAS_KEY || '' } : {}
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    return endpoint.transform(data);
  } catch (error) {
    console.warn(`Failed to fetch from ${endpoint.name}:`, error.message);
    return [];
  }
}

async function refreshWordCache() {
  if (isLoadingWords || Date.now() - lastFetchTime < FETCH_COOLDOWN) {
    return cachedWords;
  }
  
  isLoadingWords = true;
  lastFetchTime = Date.now();
  
  try {
    const results = await Promise.allSettled(
      API_ENDPOINTS.map(endpoint => fetchWordsFromAPI(endpoint))
    );
    
    const newWords = results
      .filter(result => result.status === 'fulfilled')
      .flatMap(result => result.value)
      .filter(word => 
        typeof word === 'string' && 
        word.length >= 3 && 
        word.length <= 12 &&
        /^[a-zA-Z]+$/.test(word)
      )
      .map(word => word.toLowerCase());
    
    if (newWords.length > 0) {
      const uniqueWords = [...new Set([...cachedWords, ...newWords])];
      cachedWords = uniqueWords.slice(0, 500); // Keep cache manageable
      console.log(`Word cache updated: ${cachedWords.length} total words`);
    }
  } catch (error) {
    console.warn('Error refreshing word cache:', error.message);
  } finally {
    isLoadingWords = false;
  }
  
  return cachedWords;
}

export async function getWords() {
  return await refreshWordCache();
}

export const WORDS = cachedWords;

export function randomChoices(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

export async function getRandomChoices(n = 3) {
  const words = await getWords();
  return randomChoices(words, n);
}

export function maskWord(word, revealed = new Set()) {
  return word
    .split('')
    .map((ch, i) => (ch === ' ' ? ' ' : revealed.has(i) ? ch : '_'))
    .join('');
}