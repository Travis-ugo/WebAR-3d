// =========================================================================
// 1. MINDAR CAMERA SAFETY PATCH (PREVENTING STARTUP CRASHES)
// =========================================================================
/* 
  May, here is the problem:
  Normally, if the tracking card package (targets.mind) only includes 1 target image 
  during tests, but our A-Frame scene defines 3 targets (Dino at index 2, Tree at index 1, 
  Meat at index 0), MindAR will try to read targets 1 and 2, find they are missing, 
  and crash. This crash completely locks up the camera and halts the entire app!

  To solve this, we create this "Safety Patch" function. It intercepts MindAR's 
  internal target-setup method (`setupAnchor`) and says: 
  "If the targetIndex is larger than the targets loaded, skip it safely instead of crashing!"

  We use POLLING here:
  A-Frame and MindAR load their scripts asynchronously from remote CDNs. Thus, 
  AFRAME.registeredSystems might not be defined the exact millisecond index.js runs. 
  Our script checks if AFRAME is ready. If not, it uses setInterval to check every 
  50 milliseconds, applying the patch as soon as MindAR is fully instantiated in memory.
*/
function applyMindARPatch() {
  // Check if AFRAME and MindAR system are registered in browser memory
  if (typeof AFRAME !== 'undefined' && AFRAME.registeredSystems && AFRAME.registeredSystems['mindar-image-system']) {
    const systemProto = AFRAME.registeredSystems['mindar-image-system'].prototype;
    
    // If the setupAnchor function exists and hasn't been patched yet, wrap it
    if (systemProto && systemProto.setupAnchor && !systemProto.setupAnchor.__patched) {
      const originalSetupAnchor = systemProto.setupAnchor;
      
      // Override setupAnchor with our safe version
      systemProto.setupAnchor = function (targetIndex, el) {
        // If the targetIndex is out of bounds for the loaded targets package, skip setup Anchor
        if (!this.anchors || targetIndex >= this.anchors.length) {
          console.warn(`[MindAR Patch] targetIndex ${targetIndex} is out of bounds for current targets (${this.anchors ? this.anchors.length : 0} loaded). Skipping setup for index ${targetIndex} to prevent camera crash.`);
          return; // Return early without crashing!
        }
        // Otherwise, run original setupAnchor normally
        return originalSetupAnchor.call(this, targetIndex, el);
      };
      
      systemProto.setupAnchor.__patched = true; // Mark as patched
      console.log("[MindAR Patch] Camera crash safety patch applied successfully.");
    }
    return true; // Patch applied successfully
  }
  return false; // Not ready yet, please retry
}

// Execute immediately or set up a 50ms polling loop if libraries are still loading
if (!applyMindARPatch()) {
  const patchInterval = setInterval(() => {
    if (applyMindARPatch()) {
      clearInterval(patchInterval); // Stop checking once applied
    }
  }, 50);
  // Fail-safe: stop checking after 10 seconds to avoid running CPU cycles infinitely
  setTimeout(() => clearInterval(patchInterval), 10000);
}


// =========================================================================
// 2. REGISTER THE INTERACTIVE DINOSAUR BEHAVIOR COMPONENT
// =========================================================================
/*
  In A-Frame, we write custom logic by creating Components. Think of a Component 
  as a script package we attach to an HTML tag (e.g. <a-entity dino-behavior>).
  
  The 'dino-behavior' component controls:
  - Dinosaur animations, movement, and target checks.
  - Updating the Heads-Up-Display (HUD) layout.
  - Communicating with the Web Audio Synthesizer.
*/
AFRAME.registerComponent('dino-behavior', {
  
  /*
    init() is called exactly once by A-Frame when the scene initializes.
    We use this to cache elements, define status flags, and bind event handlers.
  */
  init: function () {
    // Cache references to DOM elements in the scene graph
    this.dinoModel = document.querySelector("#dino-model");
    this.dinoWrapper = document.querySelector("#dino-model-wrapper");
    this.meatTarget = document.querySelector("#meat-target");
    this.treeTarget = document.querySelector("#tree-target");
    this.treeGltf = document.querySelector("#tree-target a-gltf-model");
    this.ambientLight = document.querySelector("#ambient-light");
    
    // Tracking state variables
    this.dinoCardTracked = false; // Is the physical Dinosaur card currently in camera view?
    this.dinoVisible = false;     // Is the dinosaur model currently active on screen?
    this.meatVisible = false;     // Is the Meat card target currently visible?
    this.treeVisible = false;     // Is the Tree card target currently visible?
    
    // Timestamps recording when the camera last saw each target
    this.lastMeatSeenTime = -999999;
    this.lastTreeSeenTime = -999999;
    
    // State Machine Properties
    // We have 5 states:
    // - "IDLE": Standing at starting home position waiting for food or trees.
    // - "WALK_TO_MEAT": Walking towards scanned meat card.
    // - "EAT": Arrived at meat target, eating, scaling food down, playing sound for 3s.
    // - "WALK_TO_TREE": Walking towards scanned tree card.
    // - "WALK_HOME": Walking back to starting origin spot.
    this.state = "IDLE"; 
    this.eatStartTime = 0; // Records when the eating process started
    this.meatConsumed = false; // Prevents dino from running back and forth repeatedly to same meat
    this.treeInspected = false; // Prevents dino from running back and forth repeatedly to same tree
    
    // Action helper flags
    this.isEating = false;
    this.isWalking = false;
    this.isScratching = false;
    
    // Default home position coords in local space
    this.homePos = new THREE.Vector3(0, 0, 0);

    // Store the dinosaur's original local position defined in HTML to preserve offsets
    this.dinoBasePos = new THREE.Vector3(0, -1.2, 0.01); // Default fallback
    if (this.dinoModel) {
      const posAttr = this.dinoModel.getAttribute('position');
      if (posAttr) {
        if (typeof posAttr === 'object') {
          this.dinoBasePos.set(posAttr.x || 0, posAttr.y || 0, posAttr.z || 0);
        } else if (typeof posAttr === 'string') {
          const parts = posAttr.trim().split(/\s+/).map(Number);
          if (parts.length >= 3) {
            this.dinoBasePos.set(parts[0], parts[1], parts[2]);
          }
        }
      }
    }
    
    // Default animation clips (will be overwritten dynamically below by scanning files)
    this.clipIdle = 'Idle';
    this.clipWalk = 'Walk';
    this.clipEat = 'Attack';
    
    // Bind context methods so "this" always refers to this component inside listener scopes
    this.updateHUD = this.updateHUD.bind(this);
    this.resetDino = this.resetDino.bind(this);

    // DINO CARD: Target Found Listener
    this.el.addEventListener('targetFound', () => {
      this.dinoCardTracked = true;
      this.updateHUD();
      if (window.dinoAudio) {
        window.dinoAudio.playRoar(); // Trigger growl roar on detection
      }
    });

    // DINO CARD: Target Lost Listener
    this.el.addEventListener('targetLost', () => {
      this.dinoCardTracked = false;
      this.updateHUD();
    });

    // MEAT CARD: Target Found/Lost Listeners
    if (this.meatTarget) {
      this.meatTarget.addEventListener('targetFound', () => {
        this.meatVisible = true;
        this.meatConsumed = false; // Reset consumed state when target card is scanned again
        
        // Reset scale and opacity of the meat model when target card is scanned
        const meatModel = document.querySelector("#meat-model-entity");
        if (meatModel) {
          meatModel.setAttribute("eat-animation", {active: false});
          if (meatModel.components["eat-animation"]) {
            meatModel.components["eat-animation"].reset();
          }
        }
        
        this.updateHUD();
      });
      this.meatTarget.addEventListener('targetLost', () => {
        this.meatVisible = false;
        this.updateHUD();
      });
    }

    // TREE CARD: Target Found/Lost Listeners
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

    // DYNAMIC GLTF ANIMATION RESOLVER
    // GLB models created by different artists might name animations 'walk', 'Run', or 'run_cycle'.
    // To make this app work on any dinosaur model, we listen for A-Frame's model-loaded event,
    // scan all animation clips packed inside the file, and map them to our variables.
    if (this.dinoModel) {
      this.dinoModel.addEventListener('model-loaded', (e) => {
        const animations = e.detail.model.animations;
        if (animations && animations.length > 0) {
          const animNames = animations.map(a => (a.name || "").toLowerCase());
          
          // Match animation names using string search keywords
          const walkIndex = animNames.findIndex(name => name.includes('walk') || name.includes('run'));
          const eatIndex = animNames.findIndex(name => name.includes('eat') || name.includes('attack') || name.includes('bite') || name.includes('hit') || name.includes('chew') || name.includes('roar'));
          const idleIndex = animNames.findIndex(name => name.includes('idle') || name.includes('stay') || name.includes('wait') || name.includes('default'));
          
          // Apply matching clips, or fallback to first clip in GLTF file if not found
          this.clipWalk = walkIndex !== -1 ? animations[walkIndex].name : animations[0].name;
          this.clipEat = eatIndex !== -1 ? animations[eatIndex].name : animations[0].name;
          this.clipIdle = idleIndex !== -1 ? animations[idleIndex].name : animations[0].name;
          
          console.log(`Resolved GLTF Clips -> Idle: ${this.clipIdle}, Walk: ${this.clipWalk}, Eat: ${this.clipEat}`);
          
          // Load default idle animation state
          this.dinoModel.setAttribute('animation-mixer', {
            clip: this.clipIdle,
            loop: 'repeat',
            crossFadeDuration: 0.4
          });
        }
      });
    }
  },

  /*
    updateHUD() updates text alerts on the top header bar and bottom status toasts.
  */
  updateHUD: function () {
    const headerStatus = document.getElementById("header-status");
    const statusToast = document.getElementById("status-toast");
    if (!headerStatus || !statusToast) return;
    
    let statusText = "Scanning Targets...";
    let toastText = "Align target cards inside the frame";
    let statusColor = "#ffffff";
    
    // Check if the meat card is active (visible or simulated)
    const isMeatActive = this.meatVisible || window.isMeatSimulated;

    if (this.dinoVisible) {
      if (this.state === "IDLE") {
        statusText = "Dinosaur Detected! 🦖";
        toastText = "Dinosaur is looking around.";
        statusColor = "#b45309"; // Amber yellow
      } else if (this.state === "WALK_TO_MEAT") {
        statusText = "Meat Detected! 🥩 Hungry Dino!";
        toastText = "Dinosaur is moving towards the meat!";
        statusColor = "#f43f5e"; // Rose red
      } else if (this.state === "EAT") {
        statusText = "Dino is Eating! 🥩 Yum!";
        toastText = "Dinosaur is enjoying its meal.";
        statusColor = "#f43f5e"; // Rose red
      } else if (this.state === "WALK_TO_TREE") {
        statusText = "Tree Spotted! 🌲 Interaction Mode";
        toastText = "Dino walks to the tree to inspect it!";
        statusColor = "#10b981"; // Vibrant Emerald Green
      } else if (this.state === "WALK_HOME") {
        statusText = "Dino going back home... 🦖";
        toastText = "Dinosaur is returning to its starting spot.";
        statusColor = "#b45309"; // Amber yellow
      } else if (this.state === "IDLE_AT_MEAT") {
        statusText = "Dino is full! 🦖";
        toastText = "Scan Dinosaur card to guide it back home.";
        statusColor = "#b45309";
      } else if (this.state === "IDLE_AT_TREE") {
        statusText = "Dino inspected tree! 🌲";
        toastText = "Scan Dinosaur card to guide it back home.";
        statusColor = "#10b981";
      }
    } else {
      // Dino card is not currently tracked
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
    
    // Update texts and styles in the document UI
    headerStatus.textContent = statusText;
    headerStatus.style.color = statusColor;
    statusToast.textContent = toastText;

    // Toggle solid vs dashed guides on the center scanner box
    const scanBox = document.getElementById("scan-box");
    if (scanBox) {
      if (this.dinoVisible || this.treeVisible || isMeatActive) {
        scanBox.classList.add("tracked"); // Solid green border
      } else {
        scanBox.classList.remove("tracked"); // Dashed indigo border
      }
    }
  },

  /*
    tick(time, timeDelta) is called by A-Frame on every single frame rendering step.
    This runs at 60 FPS (roughly every 16.6 milliseconds).
    We use this loop to:
    - Update state machine transitions.
    - Animate 3D coordinates (position and rotation).
    - Handle grace tracking periods and visibilities.
  */
  tick: function (time, timeDelta) {
    if (!this.dinoWrapper || !this.dinoModel) return;

    // A-Frame Visibility Hack:
    // If the dinosaur is walking home or visiting targets and the user camera loses view 
    // of the dinosaur card, MindAR will immediately hide it. This makes the dino disappear.
    // To solve this, we override A-Frame visibility: if the dino is active in any travel state,
    // we force visibility to remain true until it arrives safely back home.
    if (this.state !== "IDLE" || this.dinoCardTracked) {
      this.dinoVisible = true;
      this.el.setAttribute("visible", true);
    } else {
      this.dinoVisible = false;
      this.el.setAttribute("visible", false);
    }

    // Update timestamps whenever target cards are visible
    if (this.meatVisible) {
      this.lastMeatSeenTime = time;
    }
    if (this.treeVisible) {
      this.lastTreeSeenTime = time;
    }

    const wrapper = this.dinoWrapper.object3D; // Access Three.js 3D wrapper object
    const model = this.dinoModel.object3D;     // Access Three.js 3D model object
    
    // =========================================================================
    // 💡 MAY - ADJUST THIS: GRACE PERIOD TIMING
    // If a target card goes out of camera view temporarily (e.g., due to hand wiggles),
    // we don't want the dino to cancel its walk instantly.
    // 1500 represents 1.5 seconds. Increase this if you want the dino to stay active 
    // longer after the camera loses a card, or decrease it for immediate updates.
    // =========================================================================
    const gracePeriodMs = 1500;
    const isMeatActive = this.meatVisible || (time - this.lastMeatSeenTime < gracePeriodMs) || window.isMeatSimulated;
    const isTreeActive = this.treeVisible || (time - this.lastTreeSeenTime < gracePeriodMs);

    // =========================================================================
    // 💡 MAY - ADJUST THIS: LIGHT COLOR EFFECT
    // Adjust colors here to change the dynamic light color when dinosaur arrives.
    // =========================================================================
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
    } else if (this.state === "IDLE_AT_MEAT") {
      if (this.dinoCardTracked) {
        this.state = "WALK_HOME";
        this.updateHUD();
      }
    } else if (this.state === "IDLE_AT_TREE") {
      if (this.dinoCardTracked) {
        this.state = "WALK_HOME";
        this.updateHUD();
      }
    }

    // ==========================================
    // STATE SYSTEM BEHAVIORS
    // ==========================================
    if (this.state === "IDLE") {
      this.isWalking = false;
      this.isEating = false;
      this.isScratching = false;

      // Stop any active synth sounds
      if (window.dinoAudio) {
        window.dinoAudio.stopWalking();
        window.dinoAudio.stopChewing();
        window.dinoAudio.stopScratching();
      }

      // Reset positions to origin
      wrapper.position.set(0, 0, 0);
      wrapper.rotation.set(0, 0, 0);
      model.position.copy(this.dinoBasePos);
      model.rotation.set(0, 0, 0);

    } 
    
    else if (this.state === "WALK_TO_MEAT") {
      // Find where the Meat card is in physical 3D space
      const meatWorldPos = new THREE.Vector3();
      if (window.isMeatSimulated) {
        const dinoWorldPos = new THREE.Vector3();
        this.el.object3D.getWorldPosition(dinoWorldPos);
        // Simulate meat 25cm to the right of the dinosaur target
        meatWorldPos.copy(dinoWorldPos).add(new THREE.Vector3(0.25, 0, -0.05));
      } else {
        if (this.meatTarget) {
          this.meatTarget.object3D.getWorldPosition(meatWorldPos);
        } else {
          return;
        }
      }

      // Force update world matrices to get precise real-time positions
      wrapper.updateMatrixWorld(true);
      if (this.meatTarget) {
        this.meatTarget.object3D.updateMatrixWorld(true);
      }

      // Bridging World Coordinates to Local Coordinates:
      // MindAR places targets at separate points in global space. To make the dinosaur walk
      // from its origin card, we read the meat's global coordinates and convert them into 
      // coordinates relative to the dinosaur using `worldToLocal()`.
      const localTargetPos = this.el.object3D.worldToLocal(meatWorldPos.clone());
      localTargetPos.y = 0; // Flat movement plane (ignore height)

      // Calculate distance in local 2D space to ignore tracking height discrepancies
      const distance = wrapper.position.distanceTo(localTargetPos);

      // Throttled logging for real-time debugging (every 500ms)
      if (!this._lastMeatLogTime || time - this._lastMeatLogTime > 500) {
        console.log(`[DinoAI] Dist to meat: ${distance.toFixed(3)}m, Target: (${localTargetPos.x.toFixed(2)}, ${localTargetPos.z.toFixed(2)})`);
        this._lastMeatLogTime = time;
      }

      // Guard check against NaN calculations
      if (isNaN(distance) || isNaN(localTargetPos.x) || isNaN(localTargetPos.z)) {
        return;
      }

      // Proximity Glow effect: Lerps ambient light color red as dino gets close
      if (distance < 0.6) {
        const t = Math.max(0, 1 - (distance / 0.6));
        targetLightColor.lerp(new THREE.Color("#f43f5e"), t);
        targetIntensity = 1.2 + (t * 0.4);
      }

      // =======================================================================
      // 💡 MAY - ADJUST THIS: MEAT ARRIVAL THRESHOLD
      // 0.35 represents 35 centimeters. If the dinosaur gets within this distance
      // to the meat, it switches from walking to the eating animation.
      // Increase this if you want it to stop farther away, or decrease to make it walk closer.
      // =======================================================================
      const eatThreshold = 0.35; 

      if (distance > eatThreshold) {
        if (this.isEating) {
          this.isEating = false;
          if (window.dinoAudio) window.dinoAudio.stopChewing();
        }

        // 1. ROTATION CALCULATION:
        // Use Math.atan2 to calculate rotation heading angle. Smoothly rotate wrapper
        // towards target using lerping (y += diff * 0.1) to avoid sudden turns.
        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        let diff = angle - wrapper.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        wrapper.rotation.y += diff * 0.1;

        // =====================================================================
        // 💡 MAY - ADJUST THIS: WALK SPEED (MEAT PATH)
        // 0.72 scales the speed. Try changing this to 1.5 for a running dinosaur,
        // or to 0.3 for a slow-crawling dinosaur!
        // =====================================================================
        const dir = new THREE.Vector3().subVectors(localTargetPos, wrapper.position).normalize();
        const walkSpeed = 0.72 * (timeDelta / 1000);
        wrapper.position.addScaledVector(dir, walkSpeed);

        // 3. ANIMATION: Play walk clip
        if (!this.isWalking) {
          this.isWalking = true;
          this.dinoModel.setAttribute('animation-mixer', {
            clip: this.clipWalk,
            loop: 'repeat',
            crossFadeDuration: 0.3
          });
          if (window.dinoAudio) window.dinoAudio.startWalking();
        }

        // Apply a gentle side-to-side wobble animation via code to simulate physical weight
        model.position.copy(this.dinoBasePos);
        model.position.y += Math.abs(Math.sin(time * 0.006)) * 0.005;
        model.rotation.z = Math.sin(time * 0.006) * 0.05;
      } else {
        // Dino arrived at meat: transition to EAT state
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
        if (window.dinoAudio) window.dinoAudio.startChewing(); // Play crunch loop

        // Visual animation: trigger scale & opacity animation on the meat entity
        const meatModel = document.querySelector("#meat-model-entity");
        if (meatModel) {
          meatModel.setAttribute("eat-animation", {active: true, duration: 2000});
        }

        // Freeze face rotation target heading (prevents camera jitter shaking)
        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        wrapper.rotation.y = angle;

        model.position.copy(this.dinoBasePos);
        model.rotation.z = 0;
      }
    } 
    
    else if (this.state === "EAT") {
      // =======================================================================
      // 💡 MAY - ADJUST THIS: EATING DURATION
      // 3000 represents 3 seconds (3000 milliseconds).
      // Change this to 5000 if you want the dinosaur to chew for 5 seconds before returning home!
      // =======================================================================
      const chewTimeLimitMs = 3000;
      if (time - this.eatStartTime > chewTimeLimitMs) {
        this.isEating = false;
        if (window.dinoAudio) window.dinoAudio.stopChewing();

        // Mark consumed so it doesn't double-trigger walk immediately
        window.isMeatSimulated = false;
        this.meatConsumed = true; // Set flag
        this.updateHUD();

        if (this.dinoCardTracked) {
          this.state = "WALK_HOME";
        } else {
          this.state = "IDLE_AT_MEAT";
        }
        this.updateHUD();
      } else {
        // Keep still and shine bright pink light on eating dino
        model.position.copy(this.dinoBasePos);
        model.rotation.z = 0;
        targetLightColor.lerp(new THREE.Color("#f43f5e"), 1.0);
        targetIntensity = 1.6;
      }
    } 
    
    else if (this.state === "WALK_TO_TREE") {
      // Find where the Tree card is in physical space
      const treeWorldPos = new THREE.Vector3();
      if (this.treeTarget) {
        this.treeTarget.object3D.getWorldPosition(treeWorldPos);
      } else {
        return;
      }

      // Force update world matrices to get precise real-time positions
      wrapper.updateMatrixWorld(true);
      this.treeTarget.object3D.updateMatrixWorld(true);

      const localTargetPos = this.el.object3D.worldToLocal(treeWorldPos.clone());
      localTargetPos.y = 0;

      // Calculate distance in local 2D space to ignore tracking height discrepancies
      const distance = wrapper.position.distanceTo(localTargetPos);

      // Throttled logging for real-time debugging (every 500ms)
      if (!this._lastTreeLogTime || time - this._lastTreeLogTime > 500) {
        console.log(`[DinoAI] Dist to tree: ${distance.toFixed(3)}m, Target: (${localTargetPos.x.toFixed(2)}, ${localTargetPos.z.toFixed(2)})`);
        this._lastTreeLogTime = time;
      }

      if (isNaN(distance) || isNaN(localTargetPos.x) || isNaN(localTargetPos.z)) {
        return;
      }

      // Proximity Glow: Lerps ambient light color green as dino gets close to tree
      if (distance < 0.6) {
        const t = Math.max(0, 1 - (distance / 0.6));
        targetLightColor.lerp(new THREE.Color("#10b981"), t);
        targetIntensity = 1.2 + (t * 0.3);
      }

      // =======================================================================
      // 💡 MAY - ADJUST THIS: TREE ARRIVAL THRESHOLD
      // 0.35 represents 35 centimeters. Dinosaur stops walking when it gets here.
      // =======================================================================
      const treeThreshold = 0.35;

      if (distance > treeThreshold) {
        // Rotate and walk forward
        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        let diff = angle - wrapper.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        wrapper.rotation.y += diff * 0.1;

        // =====================================================================
        // 💡 MAY - ADJUST THIS: WALK SPEED (TREE PATH)
        // 0.72 scales the speed. Make sure this matches walk speed on other paths
        // unless you want the dino to speed up/slow down on its way to the tree!
        // =====================================================================
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

        // Wobble walking motion
        model.position.copy(this.dinoBasePos);
        model.position.y += Math.abs(Math.sin(time * 0.006)) * 0.005;
        model.rotation.z = Math.sin(time * 0.006) * 0.05;
      } else {
        // Arrived at tree: head home immediately (dino doesn't do anything at the tree)
        this.isWalking = false;
        if (window.dinoAudio) window.dinoAudio.stopWalking();

        // Lock face angle
        const angle = Math.atan2(localTargetPos.x - wrapper.position.x, localTargetPos.z - wrapper.position.z);
        wrapper.rotation.y = angle;

        this.treeInspected = true; // Mark as inspected
        this.updateHUD();

        model.position.copy(this.dinoBasePos);
        model.rotation.z = 0;

        if (this.dinoCardTracked) {
          this.state = "WALK_HOME";
        } else {
          this.state = "IDLE_AT_TREE";
        }
        this.updateHUD();
      }
    } 
    
    else if (this.state === "WALK_HOME") {
      const distToHome = wrapper.position.distanceTo(this.homePos);

      if (distToHome > 0.01) {

        // Smoothly rotate heading towards home coordinate (0, 0, 0)
        const angle = Math.atan2(0 - wrapper.position.x, 0 - wrapper.position.z);
        let diff = angle - wrapper.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        wrapper.rotation.y += diff * 0.1;

        // Walk home
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

        model.position.copy(this.dinoBasePos);
        model.position.y += Math.abs(Math.sin(time * 0.006)) * 0.005;
        model.rotation.z = Math.sin(time * 0.006) * 0.05;
      } else {
        // Arrived home: reset dino to IDLE and stop animations/audio
        this.resetDino();
      }
    }
    else if (this.state === "IDLE_AT_MEAT") {
      this.isWalking = false;
      this.isEating = false;
      if (window.dinoAudio) {
        window.dinoAudio.stopWalking();
        window.dinoAudio.stopChewing();
      }
      
      const mixer = this.dinoModel.getAttribute('animation-mixer');
      if (!mixer || mixer.clip !== this.clipIdle) {
        this.dinoModel.setAttribute('animation-mixer', {
          clip: this.clipIdle,
          loop: 'repeat',
          crossFadeDuration: 0.3
        });
      }
      model.position.copy(this.dinoBasePos);
      model.rotation.z = 0;
    }
    else if (this.state === "IDLE_AT_TREE") {
      this.isWalking = false;
      if (window.dinoAudio) {
        window.dinoAudio.stopWalking();
      }
      
      const mixer = this.dinoModel.getAttribute('animation-mixer');
      if (!mixer || mixer.clip !== this.clipIdle) {
        this.dinoModel.setAttribute('animation-mixer', {
          clip: this.clipIdle,
          loop: 'repeat',
          crossFadeDuration: 0.3
        });
      }
      model.position.copy(this.dinoBasePos);
      model.rotation.z = 0;
    }

    // Apply Lerped Lighting changes smoothly to ambientLight entity
    if (this.ambientLight) {
      const lightComponent = this.ambientLight.getAttribute("light");
      if (lightComponent) {
        const currentColor = new THREE.Color(lightComponent.color || "#ffffff");
        currentColor.lerp(targetLightColor, 0.08); // Transition color by 8% per frame
        
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

  /*
    resetDino() forces the state back to IDLE, resets positions/rotations, and resets scales.
  */
  resetDino: function () {
    this.isWalking = false;
    this.isEating = false;
    this.isScratching = false;
    this.state = "IDLE";

    // Silence audio
    if (window.dinoAudio) {
      window.dinoAudio.stopWalking();
      window.dinoAudio.stopChewing();
      window.dinoAudio.stopScratching();
    }
    
    if (!this.dinoWrapper || !this.dinoModel) return;
    const wrapper = this.dinoWrapper.object3D;
    const model = this.dinoModel.object3D;
    
    // Reset spatial matrices
    wrapper.position.set(0, 0, 0);
    wrapper.rotation.set(0, 0, 0);
    model.position.copy(this.dinoBasePos);
    model.rotation.set(0, 0, 0);

    if (this.treeGltf) {
      this.treeGltf.object3D.rotation.z = 0;
    }

    // Play default idle animation
    this.dinoModel.setAttribute('animation-mixer', {
      clip: this.clipIdle,
      loop: 'repeat',
      crossDuration: 0.3
    });

    // Reset scales and opacities of food items
    const meatModel = document.querySelector("#meat-model-entity");
    if (meatModel) {
      meatModel.setAttribute("eat-animation", {active: false});
      if (meatModel.components["eat-animation"]) {
        meatModel.components["eat-animation"].reset();
      }
    }
  }
});


// =========================================================================
// 3. REGISTER THE TREE COLOR PATCH COMPONENT
// =========================================================================
/*
  May, sometimes 3D models downloaded from the web render with flat black/white materials
  because their texture paths get broken inside A-Frame's standard shaders.
  This component patches the tree model meshes dynamically once loaded.
  It traverses the 3D nodes:
  - If a node name contains 'leaf' or 'leaves', it overrides its color to vibrant green.
  - If a node name contains 'bark', 'trunk', 'wood', etc., it overrides it to wood brown.
*/
AFRAME.registerComponent('tree-color-patch', {
  init: function () {
    this.el.addEventListener('model-loaded', (e) => {
      const model = e.detail.model;
      
      // Traverse all nodes in the glTF hierarchy
      model.traverse((node) => {
        if (node.isMesh) {
          const name = (node.name || "").toLowerCase();
          if (node.material) {
            node.material = node.material.clone(); // Clone material to avoid sharing with other objects
            
            if (name.includes('leaf') || name.includes('leaves')) {
              node.material.color.set('#22c55e'); // Green leaves
              node.material.roughness = 0.6;
              node.material.metalness = 0.1;
            } else if (name.includes('bark') || name.includes('trunk') || name.includes('stem') || name.includes('root') || name.includes('wood') || name.includes('branch') || name.includes('twig') || name.includes('grove')) {
              node.material.color.set('#78350f'); // Brown trunk
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
// 3.5. REGISTER EAT ANIMATION COMPONENT FOR SCALE & OPACITY FADE
// =========================================================================
AFRAME.registerComponent('eat-animation', {
  schema: {
    active: {type: 'boolean', default: false},
    duration: {type: 'number', default: 2000}
  },
  init: function () {
    this.elapsed = 0;
  },
  update: function (oldData) {
    if (this.data.active && !oldData.active) {
      this.elapsed = 0;
    } else if (!this.data.active && oldData.active) {
      this.reset();
    }
  },
  tick: function (time, timeDelta) {
    if (!this.data.active) return;
    this.elapsed += timeDelta;
    const progress = Math.min(this.elapsed / this.data.duration, 1);
    
    // Easing: easeOutQuad
    const ease = 1 - (1 - progress) * (1 - progress);
    const scaleVal = 1 - ease;
    
    this.el.object3D.scale.set(scaleVal, scaleVal, scaleVal);
    
    this.el.object3D.traverse((node) => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((mat) => {
          if (mat._originalTransparent === undefined) {
            mat._originalTransparent = mat.transparent;
          }
          if (mat._originalOpacity === undefined) {
            mat._originalOpacity = mat.opacity;
          }
          mat.transparent = true;
          mat.opacity = mat._originalOpacity * (1 - ease);
          mat.needsUpdate = true;
        });
      }
    });
    
    if (progress >= 1) {
      this.data.active = false;
    }
  },
  reset: function () {
    this.el.object3D.scale.set(1, 1, 1);
    this.el.object3D.traverse((node) => {
      if (node.isMesh && node.material) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        materials.forEach((mat) => {
          if (mat._originalTransparent !== undefined) {
            mat.transparent = mat._originalTransparent;
          }
          if (mat._originalOpacity !== undefined) {
            mat.opacity = mat._originalOpacity;
          }
          mat.needsUpdate = true;
        });
      }
    });
  }
});


// =========================================================================
// 4. REGISTER WEB AUDIO API SYNTHESIZER
// =========================================================================
/*
  Rather than downloading heavy .mp3 sound files over slow mobile networks,
  we use the browser's native Web Audio API to "synthesize" sounds (roar, chewing) 
  from scratch using raw mathematical waveforms! This keeps the project extremely fast.
*/
class ARAudioSynthesizer {
  constructor() {
    this.ctx = null;          // AudioContext node
    this.walkInterval = null;
    this.isWalking = false;
    this.chewInterval = null;
    this.isChewing = false;
    this.scratchInterval = null;
    this.isScratching = false;
  }

  /*
    init() instantiates the audio context.
    Browser security requires this to run inside a user gesture (like a button click).
  */
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

  /*
    playRoar() generates a growl sound using:
    - 2 low-pitch oscillators (sawtooth/triangle waveforms) sliding down in frequency.
    - A white noise buffer node representing growl gravel textured air.
    - Bandpass and lowpass filters shaping the sound into a deep guttural creature roar.
  */
  playRoar() {
    this.init();
    this.resume();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    
    // Create audio nodes
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const noiseNode = this.ctx.createBufferSource();
    const lowpass = this.ctx.createBiquadFilter();
    const mainGain = this.ctx.createGain();

    // Generate 2 seconds of random white noise values
    const bufferSize = this.ctx.sampleRate * 2.0; 
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1; // Random float values between -1 and 1
    }
    noiseNode.buffer = buffer;
    noiseNode.loop = true;

    // Set up noise filter to highlight growling frequencies
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(100, now);
    noiseFilter.Q.setValueAtTime(4.0, now);

    const noiseGain = this.ctx.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 1.8);

    // Set up deep sliding oscillators (sawtooth and triangle)
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(80, now); // Starts at 80Hz
    osc1.frequency.exponentialRampToValueAtTime(35, now + 1.5); // Slides down to 35Hz

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(85, now);
    osc2.frequency.exponentialRampToValueAtTime(30, now + 1.5);

    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(0.8, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 1.8);

    // Lowpass filter to cut high squeaky frequencies
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(300, now);
    lowpass.frequency.exponentialRampToValueAtTime(90, now + 1.8);
    lowpass.Q.setValueAtTime(6.0, now);

    // Connect nodes: Oscillators & Noise -> Filters -> Main Volume -> Speakers
    osc1.connect(oscGain);
    osc2.connect(oscGain);
    
    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);

    oscGain.connect(lowpass);
    noiseGain.connect(lowpass);
    
    lowpass.connect(mainGain);
    mainGain.connect(this.ctx.destination);

    // Main gain volume envelope ramp
    mainGain.gain.setValueAtTime(0, now);
    mainGain.gain.linearRampToValueAtTime(0.9, now + 0.1);
    mainGain.gain.exponentialRampToValueAtTime(0.4, now + 0.8);
    mainGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);

    // Start nodes
    osc1.start(now);
    osc2.start(now);
    noiseNode.start(now);

    // Stop nodes
    osc1.stop(now + 1.8);
    osc2.stop(now + 1.8);
    noiseNode.stop(now + 1.8);
  }

  // Walk sounds have been silenced per user requests
  startWalking() {}
  stopWalking() {}

  /*
    startChewing() plays repeated chewing crunch sounds using:
    - High-frequency white noise bursts representing teeth snapping.
    - Bandpass filter (around 600Hz) to represent crunch textures.
    - Fast exponential decays mimicking bite actions.
  */
  startChewing() {
    this.init();
    this.resume();
    if (!this.ctx || this.isChewing) return;
    this.isChewing = true;

    const playChew = () => {
      const now = this.ctx.currentTime;
      
      const bufferSize = this.ctx.sampleRate * 0.15; // 0.15s short crunch
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
    this.chewInterval = setInterval(playChew, 350); // Crunch sound loops every 350ms
  }

  stopChewing() {
    if (this.chewInterval) {
      clearInterval(this.chewInterval);
      this.chewInterval = null;
    }
    this.isChewing = false;
  }

  /*
    startScratching() generates rustling noise (leaves) with a higher frequency filter.
  */
  startScratching() {
    this.init();
    this.resume();
    if (!this.ctx || this.isScratching) return;
    this.isScratching = true;

    const playRustle = () => {
      const now = this.ctx.currentTime;
      
      const bufferSize = this.ctx.sampleRate * 0.25; 
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      
      const noise = this.ctx.createBufferSource();
      noise.buffer = buffer;
      
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2200, now); // Higher pitch for dry leaves (2.2kHz)
      filter.Q.setValueAtTime(1.0, now);
      
      const gain = this.ctx.createGain();
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
    this.scratchInterval = setInterval(playRustle, 500); 
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
// 5. DOCUMENT CONTROLLER EVENTS & CAMERA TRIGGER SYSTEM
// =========================================================================
/*
  This controls UI interaction clicks and starts A-Frame's rendering loops.
*/
function initApp() {
  const startScreen = document.getElementById("start-screen");
  const startButton = document.getElementById("start-button");
  const headerStatus = document.getElementById("header-status");
  const scanBox = document.getElementById("scan-box");
  const statusToast = document.getElementById("status-toast");
  const arScene = document.getElementById("ar-scene");

  // If critical components aren't in the DOM yet, return false to let the script retry later
  if (!arScene || !startButton) {
    console.warn("[ARApp] Required DOM elements not found. Will retry on DOMContentLoaded.");
    return false;
  }

  // Triggered when clicking "Start Camera"
  const startARScanner = () => {
    // Initialize/resume Web Audio API context from user tap gesture
    if (window.dinoAudio) {
      window.dinoAudio.init();
      window.dinoAudio.resume();
    }

    // Adjust interface layer displays
    if (startScreen) startScreen.style.display = "none"; // Hide startup screen
    if (scanBox) scanBox.style.display = "block";        // Show dashed scan frame
    if (statusToast) statusToast.style.display = "block"; // Show alert toast
    if (headerStatus) headerStatus.textContent = "Scanning for targets...";

    // Make body and html backgrounds transparent so camera feed is visible behind canvas
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";

    // Cache autostart state so reload bypasses clicking start again
    sessionStorage.setItem("ar_3d_autostart", "true");

    // Start MindAR camera streams
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

  // If A-Frame has already loaded, run autostart checks. Otherwise, register event listener
  if (arScene.hasLoaded) {
    runAutostart();
  } else {
    arScene.addEventListener("loaded", runAutostart);
  }

  // Bind click listener
  startButton.addEventListener("click", startARScanner);

  // Monitor tab changes: if user leaves tab and returns, make sure camera restarts correctly
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

  // Watch for camera permission blockages or secure context failures (HTTP vs HTTPS)
  arScene.addEventListener("arError", (event) => {
    console.error("MindAR start error:", event);
    if (headerStatus) {
      headerStatus.textContent = "Camera Error ❌";
      headerStatus.style.color = "#ef4444";
    }
    if (statusToast) statusToast.textContent = "Camera access blocked. Please check HTTPS and permissions.";
    alert("Camera Error: Access was blocked or failed.\n\nMake sure:\n1. You are visiting via HTTPS (not HTTP)\n2. Camera permissions are allowed.");
  });

  return true; // Successfully initialized
}

// Ready State Wrapper:
// If the DOM is still loading, bind to DOMContentLoaded. If it's already parsed 
// (e.g., loaded from cache), run initApp immediately. If elements aren't ready yet,
// registers event listener as a fallback.
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
