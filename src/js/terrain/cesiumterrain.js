import * as Cesium from "cesium"
import { PlaneGeometry, MeshBasicMaterial, MeshStandardMaterial, Mesh, TextureLoader, CanvasTexture, Vector3 } from "three"
import proj4 from "proj4"

export default class CesiumTerrain {
  constructor(scene) {
    this.scene = scene
    this.terrainProvider = null
    this.imageryProvider = null
    this.sampledPositions = new Map() // Cache for elevation queries
    this.tiles = new Map() // Visual terrain tiles
    this.loadingTiles = new Set()
    
    // Define UTM33N projection for Norway
    this.utm33Projection = "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs"
    
    // Add a fallback ground plane
    this.addGroundPlane()
    
    // Initialize Cesium's terrain and imagery providers
    this.initializeCesium()
    
    console.log("Cesium 3D terrain initialized")
  }
  
  addGroundPlane() {
    // Fallback ground plane
    const geometry = new PlaneGeometry(500000, 500000, 50, 50)
    const material = new MeshBasicMaterial({ 
      color: 0x4a7c59,
      wireframe: false
    })
    
    this.groundPlane = new Mesh(geometry, material)
    this.groundPlane.rotation.x = -Math.PI / 2
    this.groundPlane.position.z = -100
    this.scene.add(this.groundPlane)
    console.log("Ground plane added")
  }
  
  async initializeCesium() {
    try {
      console.log("Initializing Cesium terrain provider...")
      // Cesium World Terrain for elevation
      this.terrainProvider = Cesium.createWorldTerrainAsync({
        requestWaterMask: false,
        requestVertexNormals: false
      }).then(provider => {
        console.log("✓ Cesium terrain provider ready")
        return provider
      }).catch(err => {
        console.error("Error initializing terrain provider:", err)
        return null
      })
      
      console.log("Initializing Cesium imagery provider...")
      // Bing Maps imagery for satellite photos
      this.imageryProvider = new Cesium.IonImageryProvider({ assetId: 2 })
      console.log("✓ Cesium imagery provider ready")
      
      console.log("✓ Cesium providers initialized")
    } catch (error) {
      console.error("Error in initializeCesium:", error)
    }
  }
  
  /**
   * Convert UTM33 coordinates to lat/lon
   */
  utmToLatLon(east, north) {
    const [lon, lat] = proj4(this.utm33Projection, "WGS84", [east, north])
    return { longitude: lon, latitude: lat }
  }
  
  /**
   * Convert lat/lon to UTM33
   */
  latLonToUTM(longitude, latitude) {
    const [east, north] = proj4("WGS84", this.utm33Projection, [longitude, latitude])
    return { east, north }
  }
  
  /**
   * Get elevation at a specific point using Cesium terrain
   */
  async getElevation(longitude, latitude) {
    const cacheKey = `${longitude.toFixed(6)},${latitude.toFixed(6)}`
    
    if (this.sampledPositions.has(cacheKey)) {
      return this.sampledPositions.get(cacheKey)
    }
    
    try {
      const provider = await this.terrainProvider
      const positions = [Cesium.Cartographic.fromDegrees(longitude, latitude)]
      const updatedPositions = await Cesium.sampleTerrainMostDetailed(provider, positions)
      const elevation = updatedPositions[0].height || 0
      
      this.sampledPositions.set(cacheKey, elevation)
      return elevation
    } catch (error) {
      console.warn("Error sampling terrain elevation:", error)
      return 0
    }
  }
  
  /**
   * Get elevation at UTM coordinates
   */
  async getElevationAtUTM(east, north) {
    const { longitude, latitude } = this.utmToLatLon(east, north)
    return this.getElevation(longitude, latitude)
  }
  
  /**
   * Create a 3D terrain tile from Cesium elevation data
   */
  async createTerrainTile(centerEast, centerNorth, size = 12750) {
    const tileKey = `${centerEast}-${centerNorth}`
    
    if (this.tiles.has(tileKey) || this.loadingTiles.has(tileKey)) {
      return
    }
    
    this.loadingTiles.add(tileKey)
    console.log(`Loading tile: ${tileKey}`)
    
    try {
      const provider = await this.terrainProvider
      const resolution = 32 // 32x32 grid per tile
      const positions = []
      
      // Sample elevation grid
      const step = size / resolution
      for (let y = 0; y <= resolution; y++) {
        for (let x = 0; x <= resolution; x++) {
          const east = centerEast - size/2 + x * step
          const north = centerNorth - size/2 + y * step
          const { longitude, latitude } = this.utmToLatLon(east, north)
          positions.push(Cesium.Cartographic.fromDegrees(longitude, latitude))
        }
      }
      
      console.log(`Sampling ${positions.length} elevation points for tile ${tileKey}...`)
      
      // Get elevations from Cesium
      const sampledPositions = await Cesium.sampleTerrainMostDetailed(provider, positions)
      
      // Create geometry
      const geometry = new PlaneGeometry(size, size, resolution, resolution)
      const vertices = geometry.attributes.position.array
      
      // Apply elevation to vertices
      let minElev = Infinity, maxElev = -Infinity
      for (let i = 0; i < sampledPositions.length; i++) {
        const elevation = sampledPositions[i].height || 0
        vertices[i * 3 + 2] = elevation // Z coordinate
        minElev = Math.min(minElev, elevation)
        maxElev = Math.max(maxElev, elevation)
      }
      
      console.log(`Tile ${tileKey}: elevation range ${minElev.toFixed(0)}m to ${maxElev.toFixed(0)}m`)
      
      geometry.attributes.position.needsUpdate = true
      geometry.computeVertexNormals()
      
      // Create texture from Bing imagery
      const texture = await this.createTileTexture(centerEast, centerNorth, size, resolution)
      
      // Create material
      const material = new MeshStandardMaterial({
        map: texture,
        roughness: 0.9,
        metalness: 0.1
      })
      
      // Create mesh
      const mesh = new Mesh(geometry, material)
      mesh.position.set(centerEast, centerNorth, 0)
      mesh.rotation.x = -Math.PI / 2
      mesh.updateMatrixWorld()
      
      this.scene.add(mesh)
      this.tiles.set(tileKey, { mesh, size })
      
      console.log(`✓ Tile ${tileKey} loaded and added to scene`)
      
    } catch (error) {
      console.error(`Error creating tile ${tileKey}:`, error)
    } finally {
      this.loadingTiles.delete(tileKey)
    }
  }
  
  /**
   * Create texture from satellite imagery
   */
  async createTileTexture(centerEast, centerNorth, size, resolution) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    
    // Sample imagery at grid points
    const step = size / resolution
    const imageData = ctx.createImageData(canvas.width, canvas.height)
    
    try {
      // For now, create a simple textured appearance
      // In production, you'd fetch actual imagery from Cesium
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const idx = (y * canvas.width + x) * 4
          
          // Create terrain-like colors based on position
          const noise = Math.random() * 30
          const baseGreen = 85 + noise
          const baseBrown = 70 + noise
          
          imageData.data[idx] = baseBrown      // R
          imageData.data[idx + 1] = baseGreen  // G  
          imageData.data[idx + 2] = 50 + noise // B
          imageData.data[idx + 3] = 255        // A
        }
      }
      
      ctx.putImageData(imageData, 0, 0)
      
    } catch (error) {
      console.warn("Error creating imagery texture:", error)
      // Fallback to solid color
      ctx.fillStyle = '#557744'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    
    return new CanvasTexture(canvas)
  }
  
  /**
   * Update terrain based on camera position
   */
  async update(camera, showWireFrame) {
    // Get camera position in UTM
    const camEast = camera.position.x
    const camNorth = camera.position.y
    const camAlt = camera.position.z
    
    // Debug every 3 seconds
    if (!this.lastDebug || Date.now() - this.lastDebug > 3000) {
      console.log(`Camera: E=${camEast.toFixed(0)}, N=${camNorth.toFixed(0)}, Alt=${camAlt.toFixed(0)}m, Tiles=${this.tiles.size}`)
      this.lastDebug = Date.now()
    }
    
    // Tile size
    const tileSize = 12750 // ~12.75 km
    
    // Calculate which tiles should be visible
    const viewDistance = Math.min(camera.far, 50000) // Max 50km view
    const tilesNeeded = Math.ceil(viewDistance / tileSize)
    
    // Round camera position to tile grid
    const centerTileEast = Math.round(camEast / tileSize) * tileSize
    const centerTileNorth = Math.round(camNorth / tileSize) * tileSize
    
    // Load nearby tiles
    for (let dy = -tilesNeeded; dy <= tilesNeeded; dy++) {
      for (let dx = -tilesNeeded; dx <= tilesNeeded; dx++) {
        const tileEast = centerTileEast + dx * tileSize
        const tileNorth = centerTileNorth + dy * tileSize
        const distance = Math.sqrt(
          Math.pow(tileEast - camEast, 2) + 
          Math.pow(tileNorth - camNorth, 2)
        )
        
        if (distance < viewDistance) {
          this.createTerrainTile(tileEast, tileNorth, tileSize)
        }
      }
    }
    
    // Remove distant tiles
    const tilesToRemove = []
    for (const [key, tile] of this.tiles.entries()) {
      const [east, north] = key.split('-').map(Number)
      const distance = Math.sqrt(
        Math.pow(east - camEast, 2) + 
        Math.pow(north - camNorth, 2)
      )
      
      if (distance > viewDistance * 1.5) {
        this.scene.remove(tile.mesh)
        tile.mesh.geometry.dispose()
        tile.mesh.material.map?.dispose()
        tile.mesh.material.dispose()
        tilesToRemove.push(key)
      } else if (showWireFrame !== undefined) {
        tile.mesh.material.wireframe = showWireFrame
      }
    }
    
    tilesToRemove.forEach(key => this.tiles.delete(key))
  }
}
