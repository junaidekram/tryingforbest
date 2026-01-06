import { Vector3, Sphere, Mesh, BufferGeometry, MeshBasicMaterial, TextureLoader, MathUtils } from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js"
import { MeshoptDecoder } from "../externals/meshopt_decoder.module"

const url = new URL(document.location)
const urlParams = url.searchParams

// Use CloudFront CDN which should be publicly accessible
const SERVER = urlParams.has("local") 
  ? "" 
  : "https://d3hfnm0j2c2mh2.cloudfront.net"

export default class Tile {
  constructor(scene, terrain, tileExtents, lowerLeft) {
    this.scene = scene
    this.terrain = terrain

    this.loading = false
    this.loaded = false

    this.tileName = `${lowerLeft.x}-${lowerLeft.y}`

    const sphereRadius = Math.sqrt(0.5 * tileExtents * tileExtents)
    const tileCenter = new Vector3(lowerLeft.x + tileExtents / 2, lowerLeft.y + tileExtents / 2, 0)
    this.boundingSphere = new Sphere(tileCenter, sphereRadius)

    this.tileMesh = new Mesh()
    this.tileMesh.position.set(lowerLeft.x, lowerLeft.y, 0)
    this.tileMesh.rotateX(90 * MathUtils.DEG2RAD)
    this.tileMesh.updateMatrixWorld()

    this.tileMesh.geometry = new BufferGeometry()
    // use a very simple material, all light and shading of terrain is baked into the texture
    this.tileMesh.material = new MeshBasicMaterial()
  }

  update(camera, showWireFrame) {
    // visibility test: consider all tiles within a certain radius to be visible.
    // frustum culling is not used here, since wide camera rotations (180 degrees) will
    // then require loading an entire frustum of tiles, ie risk of visible artifacts (missing tiles).
    // by using distance as a criterion (and not view angle), only tiles at long distances
    // need to be loaded, thus reducing risks of missing tiles.
    // the tradeoff is a larger triangle count in the scene, but as long we are still
    // within performance budgets that is no problem.
    let dist =
      (this.boundingSphere.center.x - camera.position.x) * (this.boundingSphere.center.x - camera.position.x) +
      (this.boundingSphere.center.y - camera.position.y) * (this.boundingSphere.center.y - camera.position.y)
    let visible = dist < camera.far * camera.far

    // only change rendering style for loaded tiles
    // TODO: only change wireframe setting when key is pressed
    if (this.loaded) {
      this.tileMesh.material.wireframe = showWireFrame
    }

    if (visible && !this.loading && !this.loaded) {
      // this tile needs to be loaded
      this.loading = true
      // add to fetch queue - loading is spread across frames to avoid stuttering
      this.terrain.fetchQueue.push(this)
    }

    if (!visible && !this.loading && this.loaded) {
      // this tile is to be removed
      this.scene.remove(this.tileMesh)

      // dispose, ie empty, the geometry and material data
      // but do not null the geometry and material objects
      this.tileMesh.material.map.dispose()
      this.tileMesh.material.map = null

      // when we load a tile we re-populate the existing objects
      // this way we reduce GC and re-allocation of memory
      this.tileMesh.material.dispose()
      this.tileMesh.geometry.dispose()

      // free bvh memory
      this.tileMesh.geometry.boundsTree = null

      this.loaded = false
      Tile.loadCount--
    }
  }

  load() {
    const glbUrl = `${SERVER}/glb50/${this.tileName}.glb`
    const texUrl = `${SERVER}/texture/${this.tileName}.ktx2`
    
    console.log(`Loading tile ${this.tileName} from ${glbUrl}`)
    
    Tile.gltfLoader.load(
      glbUrl,
      (gltf) => {
        this.tileMesh.geometry = gltf.scene.children[0].geometry

        console.log(`${this.tileName}.glb loaded, ${this.tileMesh.geometry.index.array.length / 3} triangles`)

        Tile.bvhWorker.generate(this.tileMesh.geometry).then((bvh) => {
          this.tileMesh.geometry.boundsTree = bvh
        })

        Tile.ktx2Loader.load(
          texUrl,
          (texture) => {
            console.log(`${this.tileName}.ktx2 loaded`)

            texture.anisotropy = 16

            this.tileMesh.material.map = texture
            this.tileMesh.material.needsUpdate = true

            this.scene.add(this.tileMesh)

            this.loading = false
            this.loaded = true

            Tile.loadCount++
          },
          () => {},
          (error) => {
            console.error(`Texture error loading ${this.tileName}.ktx2:`, error)
            this.loading = false
          }
        )
      },
      () => {},
      (error) => {
        console.error(`GLB Error loading ${this.tileName}.glb from ${glbUrl}:`, error)
        this.loading = false
      }
    )
  }
}

Tile.loadCount = 0

Tile.ktx2Loader = new KTX2Loader()
Tile.ktx2Loader.setTranscoderPath("js/externals/basis/")
Tile.ktx2Loader.setCrossOrigin("anonymous")

Tile.gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
Tile.gltfLoader.setCrossOrigin("anonymous")
