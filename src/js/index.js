import SimpleTerrain from "./terrain/simpleterrain.js"
import {
  WebGLRenderer,
  Scene,
  Color,
  FogExp2,
  DirectionalLight,
  AmbientLight,
  PerspectiveCamera,
  Object3D,
  PlaneGeometry,
  MeshBasicMaterial,
  CanvasTexture,
  Mesh,
  MathUtils,
  LoadingManager,
  Ray,
  Vector3,
} from "three"
import { MTLLoader } from "three/addons/loaders/MTLLoader.js"
import { OBJLoader } from "three/addons/loaders/OBJLoader.js"
import StateVector from "./hifimodel/statevector.js"
import InputVector from "./hifimodel/inputvector.js"
import F16Simulation from "./hifimodel/f16simulation.js"
import SimulationConstants from "./hifimodel/simulationconstants.js"
import ChaseObject from "./graphics/ChaseObject.js"
import Gamepad from "./controller/gamepad.js"
import EngineSound from "./audio/enginesound.js"
import HUDObject from "./graphics/HUDObject.js"
import proj4 from "proj4"

// terrain boundaries, in UTM33 coordinates
const MINX = -100000
const MAXX = 1137000
const MINY = 6400000
const MAXY = 7970000

const TILE_EXTENTS = 50 * 255

let showWireFrame = false
let previousFrameTime = 0

let currentCamera = 0

let gamepad = null
let engineSound = null

// ray for intersection testing with ground, direction is in GLB coordinates (y up)
const interSectionRay = new Ray(new Vector3(0, 0, 0), new Vector3(0, -1, 0))

const canvas = document.getElementById("webgl")
const renderer = new WebGLRenderer({ canvas: canvas, antialias: true })
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)

const hudCanvas = document.getElementById("hud")
const hud = new HUDObject(hudCanvas)

// NOTE this makes all objects STATIC
// i.e. the matrix stack for ANY moving or rotating objects must manually be updated when needed
Object3D.matrixWorldAutoUpdate = false
Object3D.matrixAutoUpdate = false

const scene = new Scene()

scene.background = new Color(0.74, 0.74, 0.82).convertSRGBToLinear()
scene.fog = new FogExp2(scene.background, 0.000042)

// add lights to the scene, to propely display the f16 model
const directionalLight = new DirectionalLight(0xcdb5ae, 1.5)
directionalLight.position.set(0, -0.2, 0.8)
directionalLight.updateMatrixWorld()
scene.add(directionalLight)

const ambientLight = new AmbientLight(0xc7d4ed, 0.8)
scene.add(ambientLight)

// initialize cameras
const cameras = []

// main camera - internal view from cockpit
const camera = new PerspectiveCamera()
camera.up.set(0, 0, 1)
camera.fov = 45
camera.near = 1
camera.far = 50000

scene.add(camera)

cameras.push(camera)

// set up two secondary (external) cameras, derived from the main
cameras.push(camera.clone())
cameras.push(camera.clone())

// initial position of "wingman view" camera
const externalCameraPosition = {
  distance: 50,
  compass: 0,
  compassSpeed: 0,
  inclination: 90,
}

// set up container object for the 3D aircraft model
const f16 = new Object3D()
f16.visible = false
scene.add(f16)

const hudGeometry = new PlaneGeometry(1, 1)
const hudMaterial = new MeshBasicMaterial({ color: 0xffffff, transparent: true })
const hudTexture = new CanvasTexture(hudCanvas)
hudTexture.anisotropy = 1
hudMaterial.map = hudTexture

const hudPlane = new Mesh(hudGeometry, hudMaterial)
hudPlane.position.set(0, 0, -2)
hudPlane.updateMatrixWorld()
camera.add(hudPlane)
hudPlane.visible = true // HUD always visible in first-person

// load the actual aircraft model into the scene
loadAircraftModel(f16)

// register positions and orientations of aircraft object,
// to be sent to the "chase camera"
const chaseObject = new ChaseObject(f16)

// read out start position and direction
const url = new URL(document.location)
const urlParams = url.searchParams
const startPoint = getStartpointFromParameters(urlParams)
let startDirection = +urlParams.get("c") || 0

camera.position.set(startPoint[0], startPoint[1], startPoint[2])

// compensate for unknown offset in compass direction
startDirection += 8

const terrain = new SimpleTerrain(scene)

console.log(`Starting position: E=${startPoint[0].toFixed(0)}, N=${startPoint[1].toFixed(0)}, Alt=${startPoint[2].toFixed(0)}m`)

// set up physics simulation
const f16simulation = new F16Simulation()
const airplaneState = new StateVector()
airplaneState.init(startPoint, startDirection)
const airplaneControlInput = new InputVector()

// set up various event handlers
const startButton = document.getElementById("start")
startButton.addEventListener("click", start)

window.addEventListener("resize", () => {
  resetViewport()
})
window.addEventListener("keydown", keyboardHandler)
window.addEventListener("keyup", (keyboardEvent) => {
  const key = keyboardEvent.key
  switch (key) {
    case "b": // release brakes
      airplaneControlInput.brakes = 0.0
      break
  }
})

window.addEventListener("gamepadconnected", (event) => {
  console.log("Gamepad %s connected", event.gamepad.id)
  gamepad = new Gamepad()
})
window.addEventListener("gamepaddisconnected", (event) => {
  console.log("Gamepad %s disconnected", event.gamepad.id)
  gamepad = null
})

// log scene stats
setInterval(() => {
  console.log("Textures rendered: " + renderer.info.memory.textures)
  console.log("Geometries rendered: " + renderer.info.memory.geometries)
  console.log("Triangles rendered: " + renderer.info.render.triangles)
}, 3000)

// register flight trail points every N ms
setInterval(() => {
  chaseObject.addPoint(f16)
}, ChaseObject.timeInterval)

// check for ground collision and landing
let lastElevationQuery = 0
setInterval(async () => {
  // Throttle elevation queries to avoid overwhelming the API
  const now = Date.now()
  if (now - lastElevationQuery < 1000) return
  lastElevationQuery = now

  try {
    // Get current position in UTM coordinates
    const east = camera.position.x
    const north = camera.position.y
    const altitudeMeters = camera.position.z

    // For now, use a simple collision check: if altitude drops below 50m above sea level
    if (altitudeMeters < 50) {
      console.log(`COLLISION: Alt=${altitudeMeters.toFixed(0)}m`)
      document.location.href = "collision.html"
      return
    }
    
    // Also query elevation from Cesium for ground height info
    if (terrain && terrain.getElevationAtUTM) {
      const terrainHeightMeters = await terrain.getElevationAtUTM(east, north)
      const heightAboveGroundMeters = altitudeMeters - terrainHeightMeters
      
      // Update state with terrain height
      airplaneState.groundHeight = terrainHeightMeters * SimulationConstants.METERS_TO_FEET
      
      // Collision if below 4 meters AGL
      if (heightAboveGroundMeters < 4 && heightAboveGroundMeters > 0) {
        console.log(`COLLISION: Height above ground=${heightAboveGroundMeters.toFixed(1)}m`)
        document.location.href = "collision.html"
      }
    }
  } catch (error) {
    console.warn("Elevation query error:", error)
  }
}, 1000)

// the actual program startup
async function start() {
  try {
    console.log("Game starting...")
    
    // Make canvases visible first
    const webglCanvas = document.getElementById("webgl")
    const hudCanvasElement = document.getElementById("hud")
    const buttonContainer = document.getElementById("buttoncontainer")
    
    if (!webglCanvas) {
      console.error("WebGL canvas not found!")
      return
    }
    if (!hudCanvasElement) {
      console.error("HUD canvas not found!")
      return
    }
    if (!buttonContainer) {
      console.error("Button container not found!")
      return
    }
    
    // Hide button, show canvases
    buttonContainer.style.display = "none"
    webglCanvas.style.display = "block"
    hudCanvasElement.style.display = "block"
    
    // Initialize audio
    const audioContext = new window.AudioContext()
    const workletPath = new URL("./audio/brown-noise-processor.js", import.meta.url).href
    await audioContext.audioWorklet.addModule(workletPath)
    engineSound = new EngineSound()

    audioContext.resume()
    engineSound.start(audioContext)
    
    console.log("Audio initialized, starting simulation...")

    resetViewport()
    drawScene()
  } catch (error) {
    console.error("Error starting game:", error)
    alert("Error starting game: " + error.message)
  }
}

function drawScene(currentFrametime) {
  requestAnimationFrame(drawScene)

  let frameTime = currentFrametime - previousFrameTime || 0
  previousFrameTime = currentFrametime

  if (gamepad) {
    gamepad.read(airplaneControlInput)
  }

  airplaneControlInput.normalizeControls()
  
  // Update gear state and speedbrake (instant for now - could add animation)
  airplaneState.gearDown = airplaneControlInput.gearLever
  airplaneState.speedbrake = airplaneControlInput.speedbrake

  const stateDerivative = f16simulation.getStateDerivative(airplaneControlInput, airplaneState)
  airplaneState.integrate(stateDerivative, frameTime * 0.001)
  airplaneState.updateAircraftModel(f16)

  if (hudPlane.visible) {
    hud.update(airplaneState)
    hud.draw()
    hudTexture.needsUpdate = true
  }

  // always update master camera
  cameras[0].position.copy(f16.position)
  cameras[0].quaternion.copy(f16.quaternion)
  cameras[0].rotateX(90 * MathUtils.DEG2RAD)
  cameras[0].updateMatrixWorld()

  const cameraData = chaseObject.getPoint(frameTime)

  // update current camera - derived from the master camera
  switch (currentCamera) {
    case 1:
      cameras[currentCamera] = camera.clone()
      cameras[currentCamera].position.copy(cameraData.position)
      cameras[currentCamera].quaternion.copy(cameraData.quaternion)
      cameras[currentCamera].rotateX(90 * MathUtils.DEG2RAD)
      cameras[currentCamera].updateMatrixWorld()
      break
    case 2:
      cameras[currentCamera] = camera.clone()
      cameras[currentCamera].lookAt(f16.position)
      cameras[currentCamera].rotateZ(externalCameraPosition.compass * MathUtils.DEG2RAD) // compass
      cameras[currentCamera].rotateX(externalCameraPosition.inclination * MathUtils.DEG2RAD) // above / below horizon
      cameras[currentCamera].translateZ(externalCameraPosition.distance)
      cameras[currentCamera].updateMatrixWorld()

      externalCameraPosition.compass += externalCameraPosition.compassSpeed
      break
  }

  terrain.update(cameras[currentCamera], showWireFrame)
  engineSound.update(cameras[currentCamera], f16, airplaneState.pow)

  renderer.render(scene, cameras[currentCamera])
}

// calculate grid convergence angle
// https://gis.stackexchange.com/questions/115531/calculating-grid-convergence-true-north-to-grid-north
function getCompassOffset(east, north) {
  const utm33NProjection = "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs"
  const lonlat = proj4(utm33NProjection).inverse([east, north])

  const utmZone = Math.ceil((lonlat[0] + 180) / 6)
  const centralMeridian = 6 * utmZone - 183
  const lonDelta = lonlat[0] - centralMeridian

  const rotation = Math.atan(Math.tan(lonDelta * Math.DEG2RAD) * Math.sin(lonlat[1] * Math.DEG2RAD)) * Math.RAD2DEG
  return rotation
}

function getStartpointFromParameters(urlParams) {
  // set start point: UTM EAST, UTM NORTH, altitude (meters) and compass direction
  let east = +urlParams.get("e") || 105000
  let north = +urlParams.get("n") || 6970000
  const alt = +urlParams.get("a") || 1524 // 5000 ft

  // if input coordinates are GPS lat/lon, convert to utm33
  if (north < 72 && east < 33) {
    const utm33NProjection = "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs"
    const utm = proj4(utm33NProjection, [east, north])
    east = utm[0]
    north = utm[1]
  }

  const rotation = getCompassOffset(east, north)

  return [east, north, alt, rotation]
}

function loadAircraftModel(f16) {
  const manager = new LoadingManager()
  new MTLLoader(manager).setPath("f16/").load("f16.mtl", (materials) => {
    materials.preload()

    new OBJLoader(manager)
      .setMaterials(materials)
      .setPath("f16/")
      .load(
        "f16.obj",
        (object) => {
          // center the model at its center of gravity
          object.position.set(0, 2, -2.3)

          // align model with world axes
          object.rotateX(90 * MathUtils.DEG2RAD)
          object.rotateY(180 * MathUtils.DEG2RAD)
          object.updateMatrixWorld()

          f16.add(object)
        },
        (xhr) => {},
        (error) => {
          console.log("Could not load 3d model: " + error)
        }
      )
  })
}

function nextCamera() {
  currentCamera++
  currentCamera %= cameras.length
  if (currentCamera === 0) {
    f16.visible = false
    hudPlane.visible = true
  }
  if (currentCamera === 1) {
    f16.visible = true
    hudPlane.visible = false
  }
  if (currentCamera === 2) {
    f16.visible = true
    hudPlane.visible = false
  }
}

function keyboardHandler(keyboardEvent) {
  switch (keyboardEvent.key) {
    case "ArrowDown": // elevator surface up
      airplaneControlInput.elevator -= 0.3
      keyboardEvent.stopPropagation()
      keyboardEvent.preventDefault()
      break
    case "ArrowUp": // elevator surface down
      airplaneControlInput.elevator += 0.3
      keyboardEvent.stopPropagation()
      keyboardEvent.preventDefault()
      break
    case "ArrowLeft": // roll left
      airplaneControlInput.aileron += 0.3
      break
    case "ArrowRight": // roll right
      airplaneControlInput.aileron -= 0.3
      break
    case "q":
      airplaneControlInput.throttle += 0.1
      break
    case "a":
      airplaneControlInput.throttle -= 0.1
      break
    case "h": // hud toggle
      hudPlane.visible = !hudPlane.visible
      break
    case "g": // landing gear toggle
      airplaneControlInput.gearLever = !airplaneControlInput.gearLever
      console.log(`Landing gear: ${airplaneControlInput.gearLever ? "DOWN" : "UP"}`)
      break
    case "b": // brakes
      airplaneControlInput.brakes = 1.0
      break
    case "z": // rudder left
      airplaneControlInput.rudder += 0.3
      break
    case "j": // external cam left
      externalCameraPosition.compassSpeed -= 0.08
      break
    case "l": // external cam right
      externalCameraPosition.compassSpeed += 0.08
      break
    case "i": // external cam up
      externalCameraPosition.inclination -= 2
      break
    case "k": // external cam down
      externalCameraPosition.inclination += 2
      break
    case ",": // external cam nearer
      externalCameraPosition.distance -= 10
      break
    case ".": // external cam farer
      externalCameraPosition.distance += 10
      break
    case "1": // speed brake -10 degrees
      airplaneControlInput.speedbrake -= 10
      break
    case "2": // speed brake +10 degrees
      airplaneControlInput.speedbrake += 10
      break
    case " ":
      nextCamera()
      break
    case "w":
      showWireFrame = !showWireFrame
  }
}

function resetViewport() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
