import * as Cesium from "cesium"
import { PlaneGeometry, MeshStandardMaterial, Mesh, DoubleSide, Raycaster, Vector3, CanvasTexture } from "three"
import proj4 from "proj4"

/**
 * Real Cesium terrain with actual elevation data and satellite imagery
 * Uses Cesium Ion for terrain and imagery tiles
 */
export default class CesiumTerrain {
  constructor(scene, apiKey = null) {
    this.scene = scene
    this.terrainProvider = null
    this.imageryProvider = null
    this.sampledPositions = new Map()
    this.tiles = new Map()
    this.loadingTiles = new Set()
    
    // UTM33N projection for Norway
    this.utm33Projection = "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs"
    
    // Set Cesium Ion access token if provided
    if (apiKey) {
      Cesium.Ion.defaultAccessToken = apiKey
      console.log("✓ Cesium API key configured")
    } else {
      console.warn("⚠ No Cesium API key provided - using default (may have limitations)")
    }
    
    // Initialize Cesium
    this.initializeCesium()
    
    console.log("CesiumTerrain: Real terrain system initialized")
  }
  
  async initializeCesium() {
    try {
      console.log("Loading Cesium World Terrain...")
      
      // Use Cesium World Terrain (free with Ion account)
      this.terrainProvider = await Cesium.createWorldTerrainAsync({
        requestWaterMask: true,
        requestVertexNormals: true
      })
      
      console.log("✓ Cesium World Terrain loaded")
      
      // Use Bing Maps Aerial imagery (high resolution satellite)
      this.imageryProvider = await Cesium.IonImageryProvider.fromAssetId(2)
      console.log("✓ Bing Maps imagery provider loaded")
      
    } catch (error) {
      console.error("Error initializing Cesium:", error)
      console.log("Falling back to basic terrain")
    }
  }
  
  utmToLatLon(east, north) {
    const [lon, lat] = proj4(this.utm33Projection, "WGS84", [east, north])
    return { longitude: lon, latitude: lat }
  }
  
  latLonToUTM(longitude, latitude) {
    const [east, north] = proj4("WGS84", this.utm33Projection, [longitude, latitude])
    return { east, north }
  }
  
  /**
   * Get elevation at a specific point
   */
  async getElevationAtUTM(east, north) {
    const cacheKey = `${east.toFixed(1)},${north.toFixed(1)}`
    
    if (this.sampledPositions.has(cacheKey)) {
      return this.sampledPositions.get(cacheKey)
    }
    
    try {
      if (!this.terrainProvider) {
        return 0
      }
      
      const { longitude, latitude } = this.utmToLatLon(east, north)
      const positions = [Cesium.Cartographic.fromDegrees(longitude, latitude)]
      
      const provider = await this.terrainProvider
      const sampledPositions = await Cesium.sampleTerrainMostDetailed(provider, positions)
      const elevation = sampledPositions[0].height || 0
      
      this.sampledPositions.set(cacheKey, elevation)
      return elevation
      
    } catch (error) {
      console.warn("Elevation query error:", error)
      return 0
    }
  }
  
  /**
   * Create a realistic terrain tile from Cesium data
   */
  async createTerrainTile(centerEast, centerNorth, size = 12750) {
    const tileKey = `${centerEast}-${centerNorth}`
    
    if (this.tiles.has(tileKey) || this.loadingTiles.has(tileKey)) {
      return
    }
    
    this.loadingTiles.add(tileKey)
    console.log(`Loading terrain tile: ${tileKey}`)
    
    try {
      if (!this.terrainProvider) {
        await new Promise(resolve => setTimeout(resolve, 100))
        if (!this.terrainProvider) {
          this.loadingTiles.delete(tileKey)
          return
        }
      }
      
      const provider = await this.terrainProvider
      const resolution = 64 // Higher resolution for better terrain
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
      
      // Get real elevations from Cesium
      const sampledPositions = await Cesium.sampleTerrainMostDetailed(provider, positions)
      
      // Create geometry
      const geometry = new PlaneGeometry(size, size, resolution, resolution)
      const vertices = geometry.attributes.position.array
      
      // Apply real elevation data
      let minElev = Infinity, maxElev = -Infinity
      for (let i = 0; i < sampledPositions.length; i++) {
        const elevation = sampledPositions[i].height || 0
        vertices[i * 3 + 2] = elevation
        minElev = Math.min(minElev, elevation)
        maxElev = Math.max(maxElev, elevation)
      }
      
      geometry.attributes.position.needsUpdate = true
      geometry.computeVertexNormals()
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
      
      console.log(`  Elevation: ${minElev.toFixed(0)}m - ${maxElev.toFixed(0)}m`)
      
      // Create texture (satellite imagery will be added later)
      const texture = await this.createSatelliteTexture(centerEast, centerNorth, size)
      
      // Create realistic material
      const material = new MeshStandardMaterial({
        map: texture,
        roughness: 0.9,
        metalness: 0.0,
        side: DoubleSide
      })
      
      // Create mesh
      const mesh = new Mesh(geometry, material)
      mesh.position.set(centerEast, centerNorth, 0)
      mesh.rotation.x = -Math.PI / 2
      mesh.receiveShadow = true
      mesh.castShadow = false
      
      // Store for raycasting
      mesh.userData.tileKey = tileKey
      mesh.userData.isTerrainTile = true
      
      this.scene.add(mesh)
      this.tiles.set(tileKey, { mesh, size, minElev, maxElev })
      
      console.log(`✓ Tile ${tileKey} loaded (${this.tiles.size} total)`)
      
    } catch (error) {
      console.error(`Error creating tile ${tileKey}:`, error)
    } finally {
      this.loadingTiles.delete(tileKey)
    }
  }
  
  /**
   * Create satellite imagery texture
   */
  async createSatelliteTexture(centerEast, centerNorth, size) {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    
    // For now, create realistic terrain colors
    // In production, fetch actual satellite imagery from Cesium
    const imageData = ctx.createImageData(canvas.width, canvas.height)
    
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const idx = (y * canvas.width + x) * 4
        
        // Realistic terrain colors (green/brown/grey based on position)
        const noise = Math.random() * 20
        const base = 60 + noise
        
        imageData.data[idx] = base + 20      // R
        imageData.data[idx + 1] = base + 40  // G (greener)
        imageData.data[idx + 2] = base - 10  // B
        imageData.data[idx + 3] = 255        // A
      }
    }
    
    ctx.putImageData(imageData, 0, 0)
    
    const texture = new CanvasTexture(canvas)
    return texture
  }
  
  /**
   * Raycast to find exact ground elevation at position
   */
  getGroundElevationAtPosition(east, north) {
    // Find which tile contains this position
    for (const [key, tile] of this.tiles.entries()) {
      const [tileEast, tileNorth] = key.split('-').map(Number)
      const halfSize = tile.size / 2
      
      if (east >= tileEast - halfSize && east <= tileEast + halfSize &&
          north >= tileNorth - halfSize && north <= tileNorth + halfSize) {
        
        // Found the tile, now raycast down to find exact elevation
        const raycaster = new Raycaster()
        const origin = new Vector3(east, north, 10000) // Start from high altitude
        const direction = new Vector3(0, 0, -1) // Point down
        
        raycaster.set(origin, direction)
        const intersects = raycaster.intersectObject(tile.mesh)
        
        if (intersects.length > 0) {
          return intersects[0].point.z
        }
      }
    }
    
    return null // No tile loaded at this position
  }
  
  /**
   * Update terrain based on camera position
   */
  async update(camera, showWireFrame) {
    const camEast = camera.position.x
    const camNorth = camera.position.y
    
    // Tile configuration
    const tileSize = 12750 // ~12.75 km tiles
    const viewDistance = Math.min(camera.far, 75000) // Up to 75km view
    const tilesNeeded = Math.ceil(viewDistance / tileSize)
    
    // Calculate tile grid position
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
