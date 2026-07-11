// =========================================================================
// 1. MINDAR CAMERA SAFETY PATCH
// =========================================================================
// If targets.mind only has 1 target (index 0) during testing, A-Frame will normally 
// crash when trying to initialize entities for target 1 (Tree) and 2 (Meat).
// This patch intercepts setupAnchor and safely skips missing targets instead of crashing.
function applyMindARPatch() {
  if (typeof AFRAME !== 'undefined' && AFRAME.registeredSystems && AFRAME.registeredSystems['mindar-image-system']) {
    const systemProto = AFRAME.registeredSystems['mindar-image-system'].prototype;
    if (systemProto && systemProto.setupAnchor && !systemProto.setupAnchor.__patched) {
      const originalSetupAnchor = systemProto.setupAnchor;
      systemProto.setupAnchor = function (targetIndex, el) {
        if (!this.anchors || targetIndex >= this.anchors.length) {
          console.warn(`[MindAR Patch] targetIndex ${targetIndex} is out of bounds for current targets (${this.anchors ? this.anchors.length : 0} loaded). Skipping setup for index ${targetIndex} to prevent camera crash.`);
          return;
        }
        return originalSetupAnchor.call(this, targetIndex, el);
      };
      systemProto.setupAnchor.__patched = true;
      console.log("[MindAR Patch] Camera crash safety patch applied successfully.");
    }
    return true;
  }
  return false;
}

if (!applyMindARPatch()) {
  const patchInterval = setInterval(() => {
    if (applyMindARPatch()) {
      clearInterval(patchInterval);
    }
  }, 50);
  setTimeout(() => clearInterval(patchInterval), 10000);
}


// =========================================================================
// 2. REGISTER THE INTERACTIVE DINOSAUR BEHAVIOR COMPONENT
// =========================================================================
AFRAME.registerComponent('dino-behavior', {
  init: function () {
    this.dinoModel = document.querySelector("#dino-model");
    this.dinoWrapper = document.querySelector("#dino-model-wrapper");
    this.meatTarget = document.querySelector("#meat-target");
    this.treeTarget = document.querySelector("#tree-target");
    this.treeGltf = document.querySelector("#tree-target a-gltf-model");
    this.ambientLight = document.querySelector("#ambient-light");
    
    // Tracking states
    this.dinoCardTracked = false; // Is the dinosaur card physically tracked
    this.dinoVisible = false; // Is the dinosaur model active/visible on screen
    this.meatVisible = false;
    this.treeVisible = false;
    this.lastMeatSeenTime = -999999;
    this.lastTreeSeenTime = -999999;
    
    // State Machine
    this.state = "IDLE"; // IDLE, WALK_TO_MEAT, EAT, WALK_TO_TREE, WALK_HOME
    this.eatStartTime = 0;
    this.meatConsumed = false;
    this.treeInspected = false;
    
    this.isEating = false;
    this.isWalking = false;
    this.isScratching = false;
    
    // Default home state positions
    this.homePos = new THREE.Vector3(0, 0, 0);
    
    // Default animations (will overwrite if clips found in your model)
    this.clipIdle = 'Idle';
    this.clipWalk = 'Walk';
    this.clipEat = 'Attack';
    
    this.updateHUD = this.updateHUD.bind(this);
    this.resetDino = this.resetDino.bind(this);

    // Target found/lost event listeners
    this.el.addEventListener('targetFound', () => {
      this.dinoCardTracked = true;
      this.dinoVisible = true;
      this.updateHUD();
      if (window.dinoAudio) {
        window.dinoAudio.playRoar();
      }
    });
    this.el.addEventListener('targetLost', () => {
      this.dinoCardTracked = false;
      // If we are currently idle, reset and hide immediately
      if (this.state === "IDLE") {
        this.dinoVisible = false;
        this.resetDino();
      }
      this.updateHUD();
    });

    if (this.meatTarget) {
      this.meatTarget.addEventListener('targetFound', () => {
        this.meatVisible = true;
        this.meatConsumed = false; // Reset consumed state when target card is scanned again
        this.updateHUD();
      });
      this.meatTarget.addEventListener('targetLost', () => {
        this.meatVisible = false;
        this.updateHUD();
      });
    }

    if (this.treeTarget) {
      this.treeTarget.addEventListener('targetFound', () => {
        this.treeVisible = true;
        this.treeInspected = false; // Reset inspected state when target card is scanned again
        this.updateHUD();
      });
      this.treeTarget.addEventListener('targetLost', () => {
        this.treeVisible = false;
        this.updateHUD();
      });
    }

    // Dynamic GLTF animation resolver: scans loaded clips in your GLB file
    if (this.dinoModel) {
      this.dinoModel.addEventListener('model-loaded', (e) => {
        const animations = e.detail.model.animations;
        if (animations && animations.length > 0) {
          const animNames = animations.map(a => a.name.toLowerCase());
          
          // Find index of clips matching name patterns
          const walkIndex = animNames.findIndex(name => name.includes('walk') || name.includes('run'));
          const eatIndex = animNames.findIndex(name => name.includes('eat') || name.includes('attack') || name.includes('bite') || name.includes('hit') || name.includes('chew') || name.includes('roar'));
          const idleIndex = animNames.findIndex(name => name.includes('idle') || name.includes('stay') || name.includes('wait') || name.includes('default'));
          
          // Fallback to the first animation clip if no matching keyword is found
          this.clipWalk = walkIndex !== -1 ? animations[walkIndex].name : animations[0].name;
          this.clipEat = eatIndex !== -1 ? animations[eatIndex].name : animations[0].name;
          this.clipIdle = idleIndex !== -1 ? animations[idleIndex].name : animations[0].name;
          
          console.log(`Resolved GLTF Clips -> Idle: ${this.clipIdle}, Walk: ${this.clipWalk}, Eat: ${this.clipEat}`);
          this.dinoModel.setAttribute('animation-mixer', {
            clip: this.clipIdle,
            loop: 'repeat',
            crossFadeDuration: 0.4
          });
        }
      });
    }
  },

  updateHUD: function () {
    const headerStatus = document.getElementById("header-status");
    const statusToast = document.getElementById("status-toast");
    if (!headerStatus || !statusToast) return;
    
    let statusText = "Scanning Targets...";
    let toastText = "Align target cards inside the frame";
    let statusColor = "#ffffff";
    
    const isMeatActive = this.meatVisible || window.isMeatSimulated;

    if (this.dinoVisible) {
      if (this.state === "IDLE") {
        statusText = "Dinosaur Detected! 🦖";
        toastText = "Dinosaur is looking around.";
        statusColor = "#b45309"; // Amber/Brown
      } else if (this.state === "WALK_TO_MEAT") {
        statusText = "Meat Detected! 🥩 Hungry Dino!";
        toastText = "Dinosaur is moving towards the meat!";
        statusColor = "#f43f5e"; // Rose/Red
      } else if (this.state === "EAT") {
        statusText = "Dino is Eating! 🥩 Yum!";
        toastText = "Dinosaur is enjoying its meal.";
        statusColor = "#f43f5e"; // Rose/Red
      } else if (this.state === "WALK_TO_TREE") {
        statusText = "Tree Spotted! 🌲 Interaction Mode";
        toastText = "Dino walks to the tree to inspect it!";
        statusColor = "#10b981"; // Vibrant Green
      } else if (this.state === "WALK_HOME") {
        statusText = "Dino going back home... 🦖";
        toastText = "Dinosaur is returning to its starting spot.";
        statusColor = "#b45309"; // Amber/Brown
      }
    } else {
      if (isMeatActive) {
        statusText = "Meat Detected! 🥩";
        toastText = "Scan Dinosaur card to feed it!";
        statusColor = "#ef4444";
      } else if (this.treeVisible) {
        statusText = "Tree Detected! 🌲";
        toastText = "Scan Dinosaur card to view the forest!";
        statusColor = "#3b82f6";
      }
    }
    
    headerStatus.textContent = statusText;
    headerStatus.style.color = statusColor;
    statusToast.textContent = toastText;

    const scanBox = document.getElementById("scan-box");
    if (scanBox) {
      if (this.dinoVisible || this.treeVisible || isMeatActive) {
        scanBox.classList.add("tracked");
      } else {
        scanBox.classList.remove("tracked");
      }
    }
  },

  tick: function (time, timeDelta) {
    if (!this.dinoVisible || !this.dinoWrapper || !this.dinoModel) return;

    // Force A-Frame visibility true during travel states to prevent disappearance if dino card is out of view
    if (this.state !== "IDLE" || this.dinoCardTracked) {
      this.el.setAttribute("visible", true);
    } else {
      this.el.setAttribute("visible", false);
    }

    // Update target seen timestamps
    if (this.meatVisible) {
      this.lastMeatSeenTime = time;
    }
    if (this.treeVisible) {
      this.lastTreeSeenTime = time;
    }

    const wrapper = this.dinoWrapper.object3D;
    const model = this.dinoModel.object3D;
    
    // Define active status with a 1.5-second (1500ms) tracking-loss grace period
    const isMeatActive = this.meatVisible || (time - this.lastMeatSeenTime < 1500) || window.isMeatSimulated;
    const isTreeActive = this.treeVisible || (time - this.lastTreeSeenTime < 1500);

    // Dynamic Lighting State Properties
    let targetLightColor = new THREE.Color("#ffffff");
    let targetIntensity = 1.2;

    // ==========================================
    // STATE MACHINE TRANSITIONS
    // ==========================================
    if (this.state === "IDLE") {
      if (isMeatActive && !this.meatConsumed) {
        this.state = "WALK_TO_MEAT";
        this.updateHUD();
      } else if (isTreeActive && this.treeTarget && !this.treeInspected) {
        this.state = "WALK_TO_TREE";
        this.updateHUD();
      }
    } else if (this.state === "WALK_TO_MEAT") {
      if (!isMeatActive) {
        this.state = "WALK_HOME";
        this.updateHUD();
      }
    } else if (this.state === "WALK_TO_TREE") {
      if (isMeatActive && !this.meatConsumed) {
        this.state = "WALK_TO_MEAT";
        this.updateHUD();
      } else if (!isTreeActive) {
        this.state = "WALK_HOME";
        this.updateHUD();
      }
    } else if (this.state === "EAT") {
      if (!isMeatActive) {
        this.isEating = false;
        if (window.dinoAudio) window.dinoAudio.stopChewing();
        this.state = "WALK_HOME";
        this.updateHUD();
      }
    } else if (this.state === "WALK_HOME") {
      if (isMeatActive && !this.meatConsumed) {
        this.state = "WALK_TO_MEAT";
        this.updateHUD();
      } else if (isTreeActive && this.treeTarget && !this.treeInspected) {
        this.state = "WALK_TO_TREE";
        this.updateHUD();
      }
    }

    // ==========================================
    // STATE BEHAVIORS
    // ==========================================
    if (this.state === "IDLE") {
      this.isWalking = false;
      this.isEating = false;
      this.isScratching = false;

      if (window.dinoAudio) {
        window.dinoAudio.stopWalking();
        window.dinoAudio.stopChewing();
        window.dinoAudio.stopScratching();
      }

      wrapper.position.set(0, 0, 0);
      wrapper.rotation.set(0, 0, 0);
      model.position.set(0, 0, 0);
      model.rotation.set(0, 0, 0);

      // If the dino card itself is not tracked anymore and we are idle, hide the dino
      if (!this.dinoCardTracked) {
        this.dinoVisible = false;
        this.el.setAttribute("visible", false);
        this.updateHUD();
      }
    } 
    
    else if (this.state === "WALK_TO_MEAT") {
      const meatWorldPos = new THREE.Vector3();
      if (window.isMeatSimulated) {
        const dinoWorldPos = new THREE.Vector3();
        this.el.object3D.getWorldPosition(dinoWorldPos);
        meatWorldPos.copy(dinoWorldPos).add(new THREE.Vector3(0.25, 0, -0.05));
      } else {
        if (this.meatTarget) {
          this.meatTarget.object3D.getWorldPosition(meatWorldPos);
        } else {
          return;
        }
      }

      const currentWorldPos = new THREE.Vector3();
      wrapper.getWorldPosition(currentWorldPos);
      const distance = currentWorldPos.distanceTo(meatWorldPos);
      const localTargetPos = this.el.object3D.worldToLocal(meatWorldPos.clone());
      localTargetPos.y = 0;

      if (isNaN(distance) || isNaN(localTargetPos.x) || isNaN(localTargetPos.z)) {
        return;
      }

      if (distance < 0.6) {
        const t = Math.max(0, 1 - (distance / 0.6));
        targetLightColor.lerp(new THREE.Color("#f43f5e"), t);
        targetIntensity = 1.2 + (t * 0.4);
      }

      const eatThreshold = 0.35;

      if (distance > eatThreshold) {
        if (this.isEating) {
          this.isEating = false;
          if (window.dinoAudio) window.dinoAudio.stopChewing();
        }

        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        let diff = angle - wrapper.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        wrapper.rotation.y += diff * 0.1;

        const dir = new THREE.Vector3().subVectors(localTargetPos, wrapper.position).normalize();
        const walkSpeed = 0.72 * (timeDelta / 1000);
        wrapper.position.addScaledVector(dir, walkSpeed);

        if (!this.isWalking) {
          this.isWalking = true;
          this.dinoModel.setAttribute('animation-mixer', {
            clip: this.clipWalk,
            loop: 'repeat',
            crossFadeDuration: 0.3
          });
          if (window.dinoAudio) window.dinoAudio.startWalking();
        }

        model.position.y = Math.abs(Math.sin(time * 0.006)) * 0.005;
        model.rotation.z = Math.sin(time * 0.006) * 0.05;
      } else {
        // Arrived at meat target: transition to EAT state
        this.state = "EAT";
        this.eatStartTime = time;
        this.updateHUD();

        this.isWalking = false;
        if (window.dinoAudio) window.dinoAudio.stopWalking();

        this.isEating = true;
        this.dinoModel.setAttribute('animation-mixer', {
          clip: this.clipEat,
          loop: 'repeat',
          crossFadeDuration: 0.3
        });
        if (window.dinoAudio) window.dinoAudio.startChewing();

        const meatModel = document.querySelector("#meat-model-entity");
        const meatFallback = document.querySelector("#meat-fallback");
        if (meatModel) {
          meatModel.setAttribute("animation", "property: scale; to: 0 0 0; dur: 2000; easing: easeOutQuad");
        }
        if (meatFallback) {
          meatFallback.setAttribute("animation", "property: scale; to: 0 0 0; dur: 2000; easing: easeOutQuad");
        }

        // Face the meat once
        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        wrapper.rotation.y = angle;

        model.position.y = 0;
        model.rotation.z = 0;
      }
    } 
    
    else if (this.state === "EAT") {
      // If 3 seconds pass, finish eating and return home
      if (time - this.eatStartTime > 3000) {
        this.isEating = false;
        if (window.dinoAudio) window.dinoAudio.stopChewing();

        this.meatVisible = false;
        this.lastMeatSeenTime = -999999;
        window.isMeatSimulated = false;
        this.meatConsumed = true; // Mark as consumed so dino goes home and stays there
        this.updateHUD();

        this.state = "WALK_HOME";
        this.updateHUD();
      } else {
        // Enjoy eating, stay completely still
        model.position.y = 0;
        model.rotation.z = 0;

        targetLightColor.lerp(new THREE.Color("#f43f5e"), 1.0);
        targetIntensity = 1.6;
      }
    } 
    
    else if (this.state === "WALK_TO_TREE") {
      const treeWorldPos = new THREE.Vector3();
      this.treeTarget.object3D.getWorldPosition(treeWorldPos);

      const currentWorldPos = new THREE.Vector3();
      wrapper.getWorldPosition(currentWorldPos);
      const distance = currentWorldPos.distanceTo(treeWorldPos);
      const localTargetPos = this.el.object3D.worldToLocal(treeWorldPos.clone());
      localTargetPos.y = 0;

      if (isNaN(distance) || isNaN(localTargetPos.x) || isNaN(localTargetPos.z)) {
        return;
      }

      if (distance < 0.6) {
        const t = Math.max(0, 1 - (distance / 0.6));
        targetLightColor.lerp(new THREE.Color("#10b981"), t);
        targetIntensity = 1.2 + (t * 0.3);
      }

      const treeThreshold = 0.35;

      if (distance > treeThreshold) {
        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        let diff = angle - wrapper.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        wrapper.rotation.y += diff * 0.1;

        const dir = new THREE.Vector3().subVectors(localTargetPos, wrapper.position).normalize();
        const walkSpeed = 0.72 * (timeDelta / 1000);
        wrapper.position.addScaledVector(dir, walkSpeed);

        if (!this.isWalking) {
          this.isWalking = true;
          this.dinoModel.setAttribute('animation-mixer', {
            clip: this.clipWalk,
            loop: 'repeat',
            crossFadeDuration: 0.3
          });
          if (window.dinoAudio) window.dinoAudio.startWalking();
        }

        model.position.y = Math.abs(Math.sin(time * 0.006)) * 0.005;
        model.rotation.z = Math.sin(time * 0.006) * 0.05;
      } else {
        // Arrived at tree target: face once, clear tracking, and head back home
        this.isWalking = false;
        if (window.dinoAudio) window.dinoAudio.stopWalking();

        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        wrapper.rotation.y = angle;

        this.treeVisible = false;
        this.lastTreeSeenTime = -999999;
        this.treeInspected = true; // Mark tree as inspected so dino goes home and stays there
        this.updateHUD();

        model.position.y = 0;
        model.rotation.z = 0;

        this.state = "WALK_HOME";
        this.updateHUD();
      }
    } 
    
    else if (this.state === "WALK_HOME") {
      const distToHome = wrapper.position.distanceTo(this.homePos);

      if (distToHome > 0.01) {
        // Reset meat scale if it had shrunk
        const meatModel = document.querySelector("#meat-model-entity");
        const meatFallback = document.querySelector("#meat-fallback");
        if (meatModel) {
          meatModel.removeAttribute("animation");
          meatModel.setAttribute("scale", "1 1 1");
        }
        if (meatFallback) {
          meatFallback.removeAttribute("animation");
          meatFallback.setAttribute("scale", "1 1 1");
        }

        const angle = Math.atan2(0 - wrapper.position.x, 0 - wrapper.position.z);
        let diff = angle - wrapper.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        wrapper.rotation.y += diff * 0.1;

        const dir = new THREE.Vector3().subVectors(this.homePos, wrapper.position).normalize();
        const walkSpeed = 0.72 * (timeDelta / 1000);
        wrapper.position.addScaledVector(dir, walkSpeed);

        if (!this.isWalking) {
          this.isWalking = true;
          this.dinoModel.setAttribute('animation-mixer', {
            clip: this.clipWalk,
            loop: 'repeat',
            crossFadeDuration: 0.3
          });
          if (window.dinoAudio) window.dinoAudio.startWalking();
        }

        model.position.y = Math.abs(Math.sin(time * 0.006)) * 0.005;
        model.rotation.z = Math.sin(time * 0.006) * 0.05;
      } else {
        // Arrived back home: transition to IDLE
        this.state = "IDLE";
        this.updateHUD();
      }
    }

    // Apply Dynamic Proximity Lights smoothly
    if (this.ambientLight) {
      const lightComponent = this.ambientLight.getAttribute("light");
      if (lightComponent) {
        const currentColor = new THREE.Color(lightComponent.color || "#ffffff");
        currentColor.lerp(targetLightColor, 0.08);
        
        const currentIntensity = parseFloat(lightComponent.intensity || 1.2);
        const nextIntensity = currentIntensity + (targetIntensity - currentIntensity) * 0.08;
        
        this.ambientLight.setAttribute("light", {
          type: "ambient",
          color: "#" + currentColor.getHexString(),
          intensity: nextIntensity
        });
      }
    }
  },

  resetDino: function () {
    this.isWalking = false;
    this.isEating = false;
    this.isScratching = false;
    this.state = "IDLE";

    if (window.dinoAudio) {
      window.dinoAudio.stopWalking();
      window.dinoAudio.stopChewing();
      window.dinoAudio.stopScratching();
    }
    
    if (!this.dinoWrapper || !this.dinoModel) return;
    const wrapper = this.dinoWrapper.object3D;
    const model = this.dinoModel.object3D;
    
    wrapper.position.set(0, 0, 0);
    wrapper.rotation.set(0, 0, 0);
    
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);

    if (this.treeGltf) {
      this.treeGltf.object3D.rotation.z = 0;
    }

    this.dinoModel.setAttribute('animation-mixer', {
      clip: this.clipIdle,
      loop: 'repeat',
      crossDuration: 0.3
    });

    // Reset meat elements
    const meatModel = document.querySelector("#meat-model-entity");
    const meatFallback = document.querySelector("#meat-fallback");
    if (meatModel) {
      meatModel.removeAttribute("animation");
      meatModel.setAttribute("scale", "1 1 1");
    }
    if (meatFallback) {
      meatFallback.removeAttribute("animation");
      meatFallback.setAttribute("scale", "1 1 1");
    }
  }
});

// =========================================================================
// 3. REGISTER THE TREE COLOR PATCH COMPONENT
// =========================================================================
AFRAME.registerComponent('tree-color-patch', {
  init: function () {
    this.el.addEventListener('model-loaded', (e) => {
      const model = e.detail.model;
      model.traverse((node) => {
        if (node.isMesh) {
          const name = node.name.toLowerCase();
          if (node.material) {
            node.material = node.material.clone(); // Clone material to avoid sharing
            if (name.includes('leaf') || name.includes('leaves')) {
              node.material.color.set('#22c55e'); // Vibrant Green
              node.material.roughness = 0.6;
              node.material.metalness = 0.1;
            } else if (name.includes('bark') || name.includes('trunk') || name.includes('stem') || name.includes('root') || name.includes('wood')) {
              node.material.color.set('#78350f'); // Wood Brown
              node.material.roughness = 0.9;
              node.material.metalness = 0.05;
            }
          }
        }
      });
    });
  }
});

// =========================================================================
// 4. REGISTER WEB AUDIO API SYNTHESIZER
// =========================================================================
class ARAudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.walkInterval = null;
    this.isWalking = false;
    this.chewInterval = null;
    this.isChewing = false;
    this.scratchInterval = null;
    this.isScratching = false;
  }

  init() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    this.ctx = new AudioContextClass();
    console.log("[ARAudioSynthesizer] AudioContext initialized successfully.");
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playRoar() {
    this.init();
    this.resume();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    
    // 1. Create nodes
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const noiseNode = this.ctx.createBufferSource();
    const lowpass = this.ctx.createBiquadFilter();
    const mainGain = this.ctx.createGain();

    // 2. Configure noise (textured growl)
    const bufferSize = this.ctx.sampleRate * 2.0; // 2 seconds of noise
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseNode.buffer = buffer;
    noiseNode.loop = true;

    // Noise filter (guttural gravel)
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(100, now);
    noiseFilter.Q.setValueAtTime(4.0, now);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 1.8);

    // 3. Configure low pitch oscillators
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(80, now);
    osc1.frequency.exponentialRampToValueAtTime(35, now + 1.5);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(85, now);
    osc2.frequency.exponentialRampToValueAtTime(30, now + 1.5);

    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(0.8, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 1.8);

    // 4. Lowpass Filter
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(300, now);
    lowpass.frequency.exponentialRampToValueAtTime(90, now + 1.8);
    lowpass.Q.setValueAtTime(6.0, now);

    // 5. Connect Everything
    osc1.connect(oscGain);
    osc2.connect(oscGain);
    
    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);

    oscGain.connect(lowpass);
    noiseGain.connect(lowpass);
    
    lowpass.connect(mainGain);
    mainGain.connect(this.ctx.destination);

    // 6. Main Gain volume envelope
    mainGain.gain.setValueAtTime(0, now);
    mainGain.gain.linearRampToValueAtTime(0.9, now + 0.1);
    mainGain.gain.exponentialRampToValueAtTime(0.4, now + 0.8);
    mainGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);

    // 7. Start & Stop
    osc1.start(now);
    osc2.start(now);
    noiseNode.start(now);

    osc1.stop(now + 1.8);
    osc2.stop(now + 1.8);
    noiseNode.stop(now + 1.8);
  }

  startWalking() {
    // Walking dinosaur steps sound removed
  }

  stopWalking() {
    // Walking dinosaur steps sound removed
  }

  startChewing() {
    this.init();
    this.resume();
    if (!this.ctx || this.isChewing) return;
    this.isChewing = true;

    const playChew = () => {
      const now = this.ctx.currentTime;
      
      // Synthetic bite/crunch: bandpass filtered noise bursts
      const bufferSize = this.ctx.sampleRate * 0.15; // 0.15 seconds
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(600, now);
      filter.Q.setValueAtTime(2.0, now);
      
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      
      noise.start(now);
      noise.stop(now + 0.15);
    };

    playChew();
    this.chewInterval = setInterval(playChew, 350); // Fast chewing sounds
  }

  stopChewing() {
    if (this.chewInterval) {
      clearInterval(this.chewInterval);
      this.chewInterval = null;
    }
    this.isChewing = false;
  }

  startScratching() {
    this.init();
    this.resume();
    if (!this.ctx || this.isScratching) return;
    this.isScratching = true;

    const playRustle = () => {
      const now = this.ctx.currentTime;
      
      // Sound of leaves rustling and branch scraping (white noise + higher frequency BP filter)
      const bufferSize = this.ctx.sampleRate * 0.25; // 0.25 seconds
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2200, now);
      filter.Q.setValueAtTime(1.0, now);
      
      const gain = this.ctx.createGain();
      // Modulate gain slightly for scratching texture
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
      
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      
      noise.start(now);
      noise.stop(now + 0.25);
    };

    playRustle();
    this.scratchInterval = setInterval(playRustle, 500); // Scratch every 500ms
  }

  stopScratching() {
    if (this.scratchInterval) {
      clearInterval(this.scratchInterval);
      this.scratchInterval = null;
    }
    this.isScratching = false;
  }
}

// Instantiated globally so entities and UI can trigger it
window.dinoAudio = new ARAudioSynthesizer();

// =========================================================================
// 5. DOCUMENT CONTROLLER EVENTS
// =========================================================================
function initApp() {
  const startScreen = document.getElementById("start-screen");
  const startButton = document.getElementById("start-button");
  const headerStatus = document.getElementById("header-status");
  const scanBox = document.getElementById("scan-box");
  const statusToast = document.getElementById("status-toast");
  const arScene = document.getElementById("ar-scene");

  if (!arScene || !startButton) {
    console.warn("[ARApp] Required DOM elements not found. Will retry on DOMContentLoaded.");
    return false;
  }

  const startARScanner = () => {
    // Initialize Web Audio context from user gesture
    if (window.dinoAudio) {
      window.dinoAudio.init();
      window.dinoAudio.resume();
    }

    if (startScreen) startScreen.style.display = "none";
    if (scanBox) scanBox.style.display = "block";
    if (statusToast) statusToast.style.display = "block";
    if (headerStatus) headerStatus.textContent = "Scanning for targets...";

    sessionStorage.setItem("ar_3d_autostart", "true");

    const arSystem = arScene.systems ? arScene.systems["mindar-image-system"] : null;
    if (arSystem) {
      arSystem.start();
    }
  };

  const runAutostart = () => {
    const autostart = sessionStorage.getItem("ar_3d_autostart");
    if (autostart === "true") {
      startARScanner();
    }
  };

  if (arScene.hasLoaded) {
    runAutostart();
  } else {
    arScene.addEventListener("loaded", runAutostart);
  }

  startButton.addEventListener("click", startARScanner);

  // Visibility changes
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (startScreen && startScreen.style.display === "none") {
        const arSystem = arScene.systems ? arScene.systems["mindar-image-system"] : null;
        if (arSystem && !arSystem.started) {
          arSystem.start();
        }
      }
    }
  });

  // MindAR camera/engine start error event listener
  arScene.addEventListener("arError", (event) => {
    console.error("MindAR start error:", event);
    if (headerStatus) {
      headerStatus.textContent = "Camera Error ❌";
      headerStatus.style.color = "#ef4444";
    }
    if (statusToast) statusToast.textContent = "Camera access blocked. Please check HTTPS and permissions.";
    alert("Camera Error: Access was blocked or failed.\n\nMake sure:\n1. You are visiting via HTTPS (not HTTP)\n2. Camera permissions are allowed.");
  });

  return true;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initApp();
  });
} else {
  if (!initApp()) {
    document.addEventListener("DOMContentLoaded", () => {
      initApp();
    });
  }
}
