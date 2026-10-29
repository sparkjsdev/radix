// WebAudio backend for the sound and music modules of doom.wasm's host interface.
//
// Doom's s_sound.c has already done the positional mixdown, so SFX arrive as
// (channel, volume 0-127, separation 0-254) plus the raw DS* lump, which is
// decoded once per lump into an AudioBuffer. Music arrives as standard MIDI
// (MUS is converted in C) and is synthesized live by libADLMIDI's OPL3
// emulation (libadlmidi-js) in an AudioWorklet, using the embedded DMX bank
// so it sounds like Doom's GENMIDI on an Adlib/Sound Blaster. The synth's
// main-thread class is libadlmidi-js's bundled dist/libadlmidi.js, imported
// from oplModuleUrl at unlock (a static page has no package resolution).

                                                                

// libADLMIDI ADL_VolumeModels: DMX is Doom's volume curve.
const ADLMIDI_VOLUME_MODEL_DMX = 3;

// The subset of libadlmidi-js's AdlMidi used here
                   
                         
                                                               
                                                              
                                       
                                      
                                   
                                                             
               
               
                                  
 

                                   
                                                                      
                                                                  
                        
                           
                      
                                                                            
                                      
                     
                   
                                  
 

                      
                                
                 
                           
                  
                 
 

                
                   
 

export class DoomAudio {
           context              ;
          module             ;
                   options                  ;
                   log                           ;

                   sfxMaster          ;
                   buffers = new Map                            ();
                   channels = new Map                    ();

                   musicMaster          ;
                   songs = new Map              ();
          nextSongHandle = 1;
          synth          ;
          synthReady                ;
          musicVolume = 1;
          playing = false;
          playGeneration = 0;
  currentSong                                       ;

  constructor(options                   = {}) {
    this.options = options;
    this.log = options.log ?? (() => {});
    this.context = new AudioContext({ sampleRate: 44100 });
    this.sfxMaster = this.context.createGain();
    this.sfxMaster.gain.value = options.sfxGain ?? 1;
    this.sfxMaster.connect(this.context.destination);
    this.musicMaster = this.context.createGain();
    this.musicMaster.gain.value = options.musicGain ?? 0.6;
    this.musicMaster.connect(this.context.destination);
  }

  // Must be called from a user gesture before anything is audible.
  async unlock() {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    if (this.options.oplProcessorUrl && !this.synthReady) {
      this.synthReady = this.initSynth().catch((error) => {
        this.log(`OPL music unavailable: ${error instanceof Error ? error.message : String(error)}`);
        this.synth = undefined;
      });
    }
  }

  attach(module            ) {
    this.module = module;
  }

  // The object to install as Module.radixAudio when the sim runs on this
  // thread: reads lump/MIDI bytes from the module heap and forwards to the
  // byte-based methods below (which a worker-hosted sim drives via messages,
  // see ../simWorker.ts).
  hooks()                  {
    return {
      sfxStart: (channel, lumpnum, ptr, len, vol, sep) => {
        const bytes = this.buffers.has(lumpnum) ? null : this.module?.HEAPU8.subarray(ptr, ptr + len) ?? null;
        return this.startSfx(channel, lumpnum, bytes, vol, sep);
      },
      sfxUpdate: (channel, vol, sep) => this.updateSfx(channel, vol, sep),
      sfxStop: (channel) => this.stopSfx(channel),
      sfxIsPlaying: (channel) => this.isSfxPlaying(channel),
      musicRegister: (ptr, len, isMidi) => {
        if (!this.module || isMidi === 0) return 0;
        const handle = this.nextSongHandle++;
        this.registerMusic(handle, this.module.HEAPU8.slice(ptr, ptr + len));
        return handle;
      },
      musicUnregister: (handle) => this.unregisterMusic(handle),
      musicPlay: (handle, looping) => this.playMusic(handle, looping !== 0),
      musicStop: () => this.stopMusic(),
      musicPause: () => this.pauseMusic(),
      musicResume: () => this.resumeMusic(),
      musicSetVolume: (volume) => this.setMusicVolume(volume),
      musicIsPlaying: () => this.playing,
    };
  }

  get musicBackend()                  {
    return this.synth ? "opl3" : "none";
  }

  // ---- SFX ---------------------------------------------------------------

  // Decodes a DMX lump once per lumpnum; `bytes` may be null once cached
          decodeLump(lumpnum        , bytes                   )                     {
    const cached = this.buffers.get(lumpnum);
    if (cached !== undefined) {
      return cached;
    }
    if (!bytes) {
      return null;
    }
    // DMX sound lump: u16 format (3), u16 sample rate, u32 sample count,
    // then 16 bytes of padding, samples, 16 bytes of padding.
    const len = bytes.length;
    let buffer                     = null;
    if (len > 8 + 32) {
      const format = bytes[0] | (bytes[1] << 8);
      const rate = bytes[2] | (bytes[3] << 8);
      const count = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
      if (format === 3 && rate > 0 && count > 32 && count <= len - 8) {
        const samples = count - 32;
        buffer = this.context.createBuffer(1, samples, rate);
        const data = buffer.getChannelData(0);
        const start = 8 + 16;
        for (let i = 0; i < samples; i += 1) {
          data[i] = (bytes[start + i] - 128) / 128;
        }
      }
    }
    this.buffers.set(lumpnum, buffer);
    return buffer;
  }

  hasSfx(lumpnum        ) {
    return this.buffers.has(lumpnum);
  }

  // Start a sound on a Doom channel; `bytes` is the DMX lump (needed only
  // the first time a lumpnum is heard). Returns the channel or -1.
  startSfx(channel        , lumpnum        , bytes                   , vol        , sep        )         {
    this.stopSfx(channel);
    const buffer = this.decodeLump(lumpnum, bytes);
    if (!buffer || this.context.state !== "running") {
      return -1;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const gain = this.context.createGain();
    const panner = this.context.createStereoPanner();
    source.connect(gain).connect(panner).connect(this.sfxMaster);
    const entry             = { source, gain, panner, lumpnum, ended: false };
    applySfxParams(entry, vol, sep);
    source.onended = () => {
      entry.ended = true;
      if (this.channels.get(channel) === entry) {
        this.channels.delete(channel);
      }
    };
    source.start();
    this.channels.set(channel, entry);
    return channel;
  }

  updateSfx(channel        , vol        , sep        ) {
    const entry = this.channels.get(channel);
    if (entry) {
      applySfxParams(entry, vol, sep);
    }
  }

  stopSfx(channel        ) {
    const entry = this.channels.get(channel);
    if (entry) {
      this.channels.delete(channel);
      try {
        entry.source.stop();
      } catch {
        // already stopped
      }
      entry.source.disconnect();
    }
  }

  isSfxPlaying(channel        ) {
    const entry = this.channels.get(channel);
    return entry !== undefined && !entry.ended;
  }

  // ---- music -------------------------------------------------------------

          async initSynth() {
    if (!this.options.oplModuleUrl) {
      throw new Error("no oplModuleUrl");
    }
    const { AdlMidi } = (await import(/* @vite-ignore */ this.options.oplModuleUrl))                                                       ;
    const synth = new AdlMidi(this.context);
    await synth.init(this.options.oplProcessorUrl, this.options.oplWasmUrl);
    // Route through our gain instead of straight to the destination.
    synth.node.disconnect();
    synth.node.connect(this.musicMaster);

    const banks = (await synth.getEmbeddedBanks())                                  ;
    const dmx =
      banks.find((bank) => /Bobby Prince v2/i.test(bank.name)) ??
      banks.find((bank) => /default DMX/i.test(bank.name)) ??
      banks.find((bank) => /DMX/i.test(bank.name));
    if (dmx) {
      await synth.setBank(dmx.id);
      this.log(`OPL3 bank: ${dmx.name}`);
    }
    synth.setVolumeModel(ADLMIDI_VOLUME_MODEL_DMX);
    synth.setNumChips(2);
    this.synth = synth;
    this.applyMusicVolume();
    // A song may have been requested before the synth was ready.
    if (this.currentSong) {
      void this.startCurrentSong();
    }
  }

  // Standard MIDI bytes (MUS is converted in C) under a caller-chosen handle
  registerMusic(handle        , midi            ) {
    this.songs.set(handle, { midi });
  }

  unregisterMusic(handle        ) {
    this.songs.delete(handle);
    if (this.currentSong?.handle === handle) {
      this.stopMusic();
    }
  }

  playMusic(handle        , looping         ) {
    this.currentSong = { handle, looping };
    this.playing = true;
    void this.startCurrentSong();
  }

          async startCurrentSong() {
    const synth = this.synth;
    const song = this.currentSong ? this.songs.get(this.currentSong.handle) : undefined;
    if (!synth || !song || !this.currentSong) {
      return;
    }
    const generation = ++this.playGeneration;
    const looping = this.currentSong.looping;
    try {
      synth.stop();
      const midi = song.midi.slice();
      await synth.loadMidi(midi.buffer               );
      if (generation !== this.playGeneration) {
        return; // superseded by a newer play/stop
      }
      synth.setLoop(looping);
      synth.play();
    } catch (error) {
      this.log(`Music failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stopMusic() {
    this.playGeneration += 1;
    this.playing = false;
    this.currentSong = undefined;
    this.synth?.stop();
  }

  pauseMusic() {
    this.synth?.stop();
  }

  resumeMusic() {
    if (this.currentSong) {
      this.synth?.play();
    }
  }

  // Doom volume 0-127 (already scaled from the 0-15 menu setting).
  setMusicVolume(volume        ) {
    this.musicVolume = Math.max(0, Math.min(127, volume)) / 127;
    this.applyMusicVolume();
  }

          applyMusicVolume() {
    this.musicMaster.gain.value = (this.options.musicGain ?? 0.6) * this.musicVolume;
  }
}

function applySfxParams(entry            , vol        , sep        ) {
  entry.gain.gain.value = Math.max(0, Math.min(127, vol)) / 127;
  entry.panner.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
}


//# sourceURL=examples/doom/sim/DoomAudio.ts