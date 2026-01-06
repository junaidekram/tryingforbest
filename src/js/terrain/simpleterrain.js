import { PlaneGeometry, MeshStandardMaterial, Mesh } from "three"

/**
 * Simple procedural terrain system
 * Generates flat terrain tiles with elevation variation
 */
export default class SimpleTerrain {
  constructor(scene) {
    this.scene = scene
    this.tiles = new Map()
    this.tileSize = 10000 // 10km tiles
    
    console.log("SimpleTerrain: Creating basic terrain system")
    
    // Create base ground plane
    this.createBaseGround()
  }
  
  createBaseGround() {
    // Large flat ground plane at sea level
    const geometry = new PlaneGeometry(500000, 500000, 100, 100)
    const material = new MeshStandardMaterial({
      color: 0x2d5016, // Dark green
      roughness: 0.9,
      metalness: 0.0
    })
    
    const mesh = new Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.z = 0 // At sea level
    mesh.receiveShadow = true
    
    this.scene.add(mesh)
    console.log("SimpleTerrain: Base ground plane created")
  }
  
  /**
   * Create a terrain tile with simple elevation
   */
  createTerrainTile(centerEast, centerNorth) {
    const tileKey = `${centerEast}-${centerNorth}`
    
    if (this.tiles.has(tileKey)) {
      return
    }
    
    const size = this.tileSize
    const resolution = 32
    
    // Create geometry
    const geometry = new PlaneGeometry(size, size, resolution, resolution)
    const vertices = geometry.attributes.position.array
    
    // Add simple noise-based elevation
    const scale = size / resolution
    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i]
      const y = vertices[i + 1]
      
      // Simple sine-based elevation (varies 0-200m)
      const elevation = 200 * Math.sin(x / 3000) * Math.sin(y / 3000) + 500
      vertices[i + 2] = elevation
    }
    
    geometry.attributes.position.needsUpdate = true
    geometry.computeVertexNormals()
    
    // Create material
    const material = new MeshStandardMaterial({
      color: 0x3d6b1f, // Green-brown
      roughness: 0.85,
      metalness: 0.0
    })
    
    // Create mesh
    const mesh = new Mesh(geometry, material)
    mesh.position.set(centerEast, centerNorth, 0)
    mesh.rotation.x = -Math.PI / 2
    mesh.receiveShadow = true
    
    this.scene.add(mesh)
    this.tiles.set(tileKey, { mesh, size })
    
    console.log(`SimpleTerrain: Tile ${tileKey} created`)
  }
  
  /**
   * Get elevation at a position
   */
  async getElevationAtUTM(east, north) {
    // Simple elevation function based on sine waves
    const elevation = 200 * Math.sin(east / 3000) * Math.sin(north / 3000) + 500
    return elevation
  }
  
  /**
   * Update terrain around camera position
   */
  async update(camera, showWireFrame) {
    const camEast = camera.position.x
    const camNorth = camera.position.y
    
    // Generate tiles around camera
    const gridDist = this.tileSize * 1.5
    const gridSnap = Math.round(camEast / this.tileSize) * this.tileSize
    
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const tileEast = gridSnap + dx * this.tileSize
        const tileNorth = Math.round(camNorth / this.tileSize) * this.tileSize + dy * this.tileSize
        
        const dist = Math.sqrt(
          Math.pow(tileEast - camEast, 2) + 
          Math.pow(tileNorth - camNorth, 2)
        )
        
        if (dist < gridDist) {
          this.createTerrainTile(tileEast, tileNorth)
        }
      }
    }
    
    // Update wireframe
    for (const tile of this.tiles.values()) {
      if (showWireFrame !== undefined) {
        tile.mesh.material.wireframe = showWireFrame
      }
    }
  }
}
