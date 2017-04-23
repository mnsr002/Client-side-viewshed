define('ClientVS', [
	"dojo/_base/declare",
	"esri/geometry/Point",
	"esri/geometry/geometryEngineAsync",
	"esri/geometry/support/webMercatorUtils",
	"esri/geometry/Circle",
	"esri/geometry/Polyline",
	"esri/geometry/Polygon",
	"esri/symbols/SimpleMarkerSymbol",
	"esri/Graphic"
],
function (declare, Point, geoEngineAsync, wmUtils, Circle, Polyline, Polygon, SMS, G) {
	return declare(null, {
	    constructor: function(view){
	      if (!view){
	      	throw "Please pass a scene view to the ClientVS constructor.";
	      }
	      this.view = view;
	    },
	    /**
	  	*
	  	* @param: {point} esriPoint - center of vs
		* @param: {radius} number - radius of vs (meters)
		* @param {resolution} number - width/height of pixel in meters, determines resolution of viewshed
		* options: {inputGeometry: any, radius: number, pixelWidth: number, observerHeight: number, objectHeight: number}
		*/
		doClientVS(options){
		    return new Promise((fulfill, reject) => {
		  	    let point = options.inputGeometry.spatialReference.isWGS84 ? wmUtils.geographicToWebMercator(options.inputGeometry) : options.inputGeometry,
			        radius = options.radius || 5000,
			        resolution = options.pixelWidth || 10,
			        subjectHeight = options.observerHeight || 2,
			        objectHeight = options.objectHeight;

			    // create a circle based on radius and center
			    let circle = this.buildCircle([point.longitude, point.latitude], radius);
			    
			    //
			    this.buildBounds(circle, resolution).then(bounds => {
			    	let xAxis = bounds.x.paths[0];
			        let yAxis = bounds.y.paths[0];
			        let top = bounds.top.paths[0];
			        let right = bounds.right.paths[0];

			        let elevationRaster = new Array(xAxis.length * yAxis.length).fill(null);

			        let raster = {
			            view: this.view,
			            pixels: new Array(xAxis.length * yAxis.length).fill(false),
			            circle: circle,
			            xAxis: xAxis,
			            yAxis: yAxis,
			            top: top,
			            right: right,
			            pixelsLength: xAxis.length * yAxis.length,
			            pixelsWidth: xAxis.length,
			            pixelsCenter: [Math.floor(xAxis.length/2),Math.floor(yAxis.length/2)],
			            geoPointCenter: [xAxis[Math.floor(xAxis.length/2)][0],yAxis[Math.floor(yAxis.length/2)][1]],
			            subjectHeight: subjectHeight,
			            objectHeight: objectHeight
			        }

			        // fetch all the needed elevations from the basemapterrain
			        elevationRaster = elevationRaster.map((cell, index) => {
				        let geoPoint = this.indexToGeoPoint(index, raster);
				        return this.geoPointToElevation(wmUtils.webMercatorToGeographic(geoPoint), this.view);
			        });

			        raster.elevationRaster = elevationRaster;

			        this.computeViewshed(raster).then(result => {
			          
			        	let rings = result.map((r)=>r.points);

			        	fulfill(new Polygon({
			            	rings: rings,
			            	spatialReference: { wkid: 3857 }
		            	}));

			        });
			    });
		    });

		},

		// return a geodesic circle given an extent and radius
		buildCircle: function(center, radius){
		    return new Circle({
		    	center: center,
		    	radius: radius,
		    	radiusUnit: 'meters',
		    	geodesic: true
		    });
		},

		buildBounds: function(circle, resolution){
		    let lineArray = [];

		    lineArray.push({
		     	line: new Polyline({
			        paths: [
			          [circle.extent.xmin, circle.extent.ymin],
			          [circle.extent.xmax, circle.extent.ymin]
			        ]
		      	}),
		      	name: 'x'
		    });

		    lineArray.push({
		      	line: new Polyline({
			        paths: [
			          [circle.extent.xmin, circle.extent.ymin],
			          [circle.extent.xmin, circle.extent.ymax]
			        ]
		      	}),
		      	name: 'y'
		    });

		    lineArray.push({
		      	line: new Polyline({
			        paths: [
			          [circle.extent.xmin, circle.extent.ymax],
			          [circle.extent.xmax, circle.extent.ymax]
			        ]
		      	}),
		     	 name: 'top'
		    });

		    lineArray.push({
		      	line: new Polyline({
			        paths: [
			          [circle.extent.xmax, circle.extent.ymax],
			          [circle.extent.xmax, circle.extent.ymin]
			        ]
		      	}),
		      	name: 'right'
		    });

		    return new Promise((resolve,reject) => {
		    	Promise.all(lineArray.map(line => {
			        let wmLine = wmUtils.geographicToWebMercator(line.line);
			        return geoEngineAsync.densify(wmLine, resolution, 9001).then(result => {
			          return {
			            name: line.name,
			            line: result
			          }
			        });
		      	})).then(results => {
		    		let resultsDict = results.reduce((accum, curr) => {
		    			accum[curr.name] = curr.line;
		    			return accum;
		    		},{});

		    		resolve(resultsDict);
		    	});
		    });
		},
		
		computeViewshed: function(raster){
		    let circleRadius = Math.min(raster.pixelsCenter[0],raster.pixelsCenter[1]) - 1;
		    let circle = this.drawCircle(raster.pixelsCenter, circleRadius);


		    return new Promise((resolve,reject)=>{
		    	// let square = left.concat(top,right,bottom);
		    	circle.forEach((point)=>{
			        let line = this.drawLine(raster.pixelsCenter,point);
			        let resultLine = this.testLine(line,raster);
		        	this.flipLine(resultLine,raster);
		      	});

		      	this.traceResult(raster, 2).then((rings)=>{
		        	resolve(rings);
		      	});
		    });
		},
		
		// count up result pixels to see how many can be seen and how many can't
		countPixels: function(pixels){
    		let numTrue = 0;
   			let numFalse = 0;
    		pixels.forEach((px)=>{
      			if (px===true){
        			numTrue++;
      			} else {
       				numFalse++
      			}
    		});

    		return {
		      	true: numTrue,
		      	false: numFalse
			}
  		},

  		pointToIndex: function(point,width,length){
		    let idx = point[1] * width + point[0];
		    
		    if (idx < length && idx >= 0){
		    	return idx;
		    } else {
		    	return null
		    }
		},

		indexToPoint: function(idx,width){
		    const x = idx % width;
		    const y = (idx - x) / width;
		    return([x,y]);
		},

  		indexToGeoPoint: function(idx,raster){
		    let point = this.indexToPoint(idx,raster.pixelsWidth);
		    return this.pointToGeoPoint(point,raster);
  		},

  		pointToGeoPoint: function(point,raster){
    		return new Point({
		      	longitude: raster.xAxis[point[0]][0],
		      	latitude: raster.yAxis[point[1]][1],
		      	spatialReference: { wkid: 4326 }
		    });
  		},

  		pointToLngLat: function(point,raster){
    		return [
			    raster.xAxis[point[0]][0],
			    raster.yAxis[point[1]][1]
    		]
  		},

  		geoPointToElevation: function(point, view){
		    let height = view.basemapTerrain.getElevation(point);
		    return height;
  		},

  		pointToElevation: function(point,raster){
		    let idx = this.pointToIndex(point, raster.pixelsWidth, raster.pixelsLength);
		    return raster.elevationRaster[idx];
		    // let geoPoint = pointToGeoPoint(point,raster);
		    // return geoPointToElevation(geoPoint,raster.view);
		},

		distance: function(point1,point2){
    		return Math.sqrt( (Math.pow(point2[0] - point1[0], 2)) + (Math.pow(point2[1] - point1[1], 2)) );
  		},

		// bresenham line rasterization algorithm
		drawLine: function(point1, point2){
		    let line = [];

		    let deltaX = point2[0] - point1[0];
		    let deltaY = point2[1] - point1[1];

		    let dx1 = deltaX < 0 ? -1 : 1;
		    let dy1 = deltaY < 0 ? -1 : 1;
		    let dx2 = deltaX < 0 ? -1 : 1;
		    let dy2 = 0;

		    let longest = Math.abs(deltaX);
		    let shortest = Math.abs(deltaY);

    		if (!(longest>shortest)){
    			longest = Math.abs(deltaY);
		      	shortest = Math.abs(deltaX);

      			dy2 = deltaY < 0 ? -1 : 1;
      			dx2 = 0;
    		}

    		let numerator = longest >> 1;

		    let currX = point1[0];
		    let currY = point1[1];

    		for (let i = 0; i <= longest; i++){
		    	line.push([currX,currY]);
		    	numerator += shortest;

      			if (!(numerator < longest)){
			        numerator -= longest;
			        currX += dx1;
			        currY += dy1;
      			} else {
			        currX += dx2;
			        currY += dy2;
      			}
    		}

    		return line;
  		},

		// draw a circle given a center and radius in raster space
	  	// angle for later to only computer viewshed for some angle
		drawCircle: function(center,radius, angle){
			let circle = [],
        		x = radius,
		        y = 0,
		        err = 0,
		        octant1 = [],
		        octant2 = [],
		        octant3 = [],
		        octant4 = [],
		        octant5 = [],
		        octant6 = [],
		        octant7 = [],
		        octant8 = [];

	    	while (x >= y) {

		        octant1.push([center[0] + x, center[1] + y]);
		        octant2.push([center[0] + y, center[1] + x]);
		        octant3.push([center[0] - y, center[1] + x]);
		        octant4.push([center[0] - x, center[1] + y]);
		        octant5.push([center[0] - x, center[1] - y]);
		        octant6.push([center[0] - y, center[1] - x]);
		        octant7.push([center[0] + y, center[1] - x]);
		        octant8.push([center[0] + x, center[1] - y]);

		        if (err <= 0) {
		            y += 1;
		            err += (2*y) + 1;
		        } else if (err > 0) { // else if makes this a "thick" circle.  no diagnal connections
		            x -= 1;
		            err -= (2*x) + 1;
		        }
		    }

		    octant1.shift();
		    octant2.reverse().shift();
		    octant3.shift();
		    octant4.reverse().shift();
		    octant5.shift();
		    octant6.reverse().shift();
		    octant7.shift();
		    octant8.reverse().shift();

		    return octant1.concat(octant2, octant3, octant4, octant5, octant6, octant7, octant8);

	  	},

  		slope: function(point1, point2, raster){
		    let h1 = this.pointToElevation(point1,raster) + raster.subjectHeight;
		    let h2 = this.pointToElevation(point2,raster) + raster.objectHeight;
		    return (h2 - h1) / this.distance(point1,point2);
  		},

  		// returns [{point:[x,y],bool: true/false},{...}]
  		testLine: function(line,raster){
		    let origin = line[0];
		    let highestSlope = -Infinity;
    		// let lastWasTrue = true;

    		return line.map(p => {
      			if (p[0] === origin[0] && p[1] === origin[1]){
        			return {
			        	bool: true,
			        	point: p
			        }
      			} else {
			        let slopeRes = this.slope(origin, p, raster);
			        if (slopeRes >= highestSlope){
          				highestSlope = slopeRes;
			            
			            return {
				            bool: true,
				            point: p
			          	}
			        } else {
			        	return {
				            bool: false,
				            point: p
			          	}
			        }
			    }
			}).filter((res)=>res.bool===true);
		},

  		flipLine: function(resultLine,raster){
		    resultLine.forEach((result)=>{
		    	let idx = this.pointToIndex(result.point, raster.pixelsWidth, raster.pixelsLength);
		    	if (idx){
		        	raster.pixels[idx] = true;
		      	}
		    });
  		},

		/**
		* Traces outline of result, returns polygon with rings based on that
		* Adapted from potrace tracing algorithm
		*
		*/
		traceResult: function(raster, smallestArea){
		    return new Promise((resolve,reject)=>{
		    	let currentPoint = [0,0];
		      	let rings = [];
		      	let iter = 0;
		      	
		      	while(true){
		        	currentPoint = this.findNext(currentPoint,raster);
		        	if (!currentPoint) break;

		        	let newRing = this.findRing(currentPoint,raster);
		        	this.flipRing(newRing,raster);
		        	if (newRing.area > smallestArea){
		        		// newRing.points = this.ringToMap(newRing.points,raster)
		          		rings.push(newRing);
		        	}
		        }
		        this.evenOddCheck(rings, raster);
		        // rings.sort((a,b) => {
		        //     if (a.points.length > b.points.length){
		        //       return -1;
		        //     } else if (a.points.length < b.points.length){
		        //       return 1;
		        //     } else {
		        //       return 0;
		        //     }
	        	// });
		        // console.log(rings);
		      	rings.forEach(ring => ring.points = this.ringToMap(ring.points,raster));
		    	resolve(rings);
		    });
		},

		// to see if a given ring should be hollow (which means we reverse it)
		// https://en.wikipedia.org/wiki/Even%E2%80%93odd_rule
		evenOddCheck: function(rings, raster){
			rings.forEach((ring,idx) => {
				let intersections = 0;
				let x = ring.xMin;
				let y = ring.yAtXmin;
				
				
				while (x > 0){
					for (let j = 0; j < rings.length; j++){
						if (j !== idx && (
							x >= rings[j].xMin &&
							x <= rings[j].xMax &&
							y >= rings[j].yMin &&
							y <= rings[j].yMax)) {

							let points = rings[j].points;
							let l = points.length - 1;
							for (let k = 0; k < points.length; k++){
								// console.log(rings[k][0],rings[l][0])
								// (x < ((points[l][0] - points[k][0]) * (y - points[k][1]) / (points[l][1] - points[k][1]) + points[k][0]))
								// ((points[k][0] > x) !== (points[l][0] > x))
								if (((points[k][1] > y) !== (points[l][1] > y)) &&
									((points[k][0] === x) || (points[l][0] === x))){
									let [lng,lat] = this.pointToLngLat([x,y],raster);
									let g = new G({
										geometry: new Point({
											x: lng,
											y: lat,
											spatialReference: {wkid: 3857}
										}),
										symbol: new SMS({
										  style: "square",
										  color: "blue",
										  size: "8px",  // pixels
										  outline: {  // autocasts as esri/symbols/SimpleLineSymbol
										    color: [ 255, 255, 0 ],
										    width: 3  // points
										  }
										})
									});
									this.view.graphics.add(g);
									intersections++;
									// continue;
								}
								l = k;
							}
						}
					}
					x--;
					
				}

				console.log(intersections);
				if (intersections % 2 !== 0){
					ring.points.reverse();
				}
				// if (ring.area < 50){
				// 	ring.points.reverse();
				// 	ring.didFlip = true;
				// }
				
			});
		},

  		ringToMap: function(points,raster){
    		return points.map((p)=> this.pointToLngLat(p,raster));
  		},

  		findNext: function(point,raster){
    		let idx = this.pointToIndex(point,raster.pixelsWidth,raster.pixelsLength);
    		while (idx < raster.pixelsLength && raster.pixels[idx] === false){
        		idx += 1;
    		}
    
    		if (idx >= raster.pixelsLength){
      			return null;
    		} else {
      			return this.indexToPoint(idx,raster.pixelsWidth);
    		}

  		},	

	  	findRing: function(point,raster){
		    let ring = [],
		        origin = [point[0],point[1]],
		        x = point[0],
		        y = point[1],
		        dirX = 0,
		        dirY = 1,
		        xMax = -Infinity,
		        yMax = -Infinity,
		        xMin = Infinity,
		        yAtXmin = null,
		        yMin = Infinity,
		        area = 0,
		        tmp;

	    	while (true){
	      		ring.push([x,y]);

			    if (x > xMax){
			       	xMax = x;
			    }
	      		if (x < xMin){
	        		xMin = x;
	        		yAtXmin = y
	      		}
	      		if (y > yMax){
	        		yMax = y;
	      		}
	      		if (y < yMin){
	        		yMin = y;
	      		}

			    x += dirX;
			    y += dirY;

			    area -= x * dirY;

		      	if (x === origin[0] && y === origin[1]){
		        	ring.push([x,y]);
		        	break;
		      	}

		        let l = raster.pixels[this.pointToIndex([ x + ((dirX + dirY -1) / 2), y + ((dirY - dirX -1) / 2) ],raster.pixelsWidth, raster.pixelsLength)];
		        let r = raster.pixels[this.pointToIndex([ x + (( dirX - dirY - 1) / 2), y + ((dirY + dirX -1) / 2) ],raster.pixelsWidth, raster.pixelsLength)];

		        if (r && !l){
			        tmp = dirX;
			        dirX = dirY;
			        dirY = -tmp;
		      	} else if (r){
			        tmp = dirX;
			        dirX = -dirY;
			        dirY = tmp;
	        	} else if (!l){
			        tmp = dirX;
			        dirX = dirY;
			        dirY = -tmp;
	      		}
	    	}	

		   	return {
		    	points: ring,
			    area: area,
			    xMin: xMin,
			    yAtXmin: yAtXmin,
			    yMin: yMin,
			    xMax: xMax,
			    yMax: yMax 
		    };
		},

  		flipRing: function(ring,raster){
		    let x, y, xMax, yMin;
		    let y1 = ring.points[0][1];

   			ring.points.forEach((p)=>{
			    x = p[0];
			    y = p[1];
    			if (y !== y1){
			        yMin = y1 < y ? y1 : y;
			        xMax = ring.xMax;
			        for (let i = x; i < xMax; i++){
          				this.flipPoint([i,yMin],raster);
        			}
        			y1 = y;
      			}
    		});
  		},

  		flipPoint: function(point,raster){
		    let idx = this.pointToIndex(point, raster.pixelsWidth, raster.pixelsLength);
		    if (idx){
      			raster.pixels[idx] = !raster.pixels[idx];
    		}
  		}
  	});   
});