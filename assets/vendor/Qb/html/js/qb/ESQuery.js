/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


importScript("../util/CNV.js");
importScript("../util/aDate.js");
importScript("../util/aUtil.js");
importScript("../util/aParse.js");
importScript("../debug/aLog.js");
importScript("MVEL.js");
importScript("Qb.js");

importScript("../rest/ElasticSearch.js");
importScript("../rest/Rest.js");



var ESQuery = function(query){
	this.query = query;
	this.compile();
};


ESQuery.TrueFilter = {"match_all":{}};

ESQuery.DEBUG=false;

////////////////////////////////////////////////////////////////////////////////
// THESE ARE THE AVAILABLE ES INDEXES/TYPES
////////////////////////////////////////////////////////////////////////////////
ESQuery.INDEXES={
	"bugs":{"host":"http://elasticsearch7.metrics.scl3.mozilla.com:9200", "path":"/bugs/bug_version"},
	"public_bugs":{"host":"https://esfrontline.bugzilla.mozilla.org:443", "path":"/public_bugs/bug_version"},
	"public_bugs_backend":{"host":"http://elasticsearch-zlb.bugs.scl3.mozilla.com:9200", "path":"/public_bugs/bug_version"},
	"public_bugs_proxy":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9201", "path":"/public_bugs/bug_version"},
	"private_bugs":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/private_bugs/bug_version"},
	"private_comments":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/private_comments/bug_comment"},

	"tor_bugs":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9200", "path":"/bugs/bug_version"},
	"tor_public_bugs":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9200", "path":"/public_bugs/bug_version"},
	"tor_private_bugs":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9200", "path":"/private_bugs/bug_version"},
	"bug_hierarchy":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9200", "path":"/bug_hierarchy/bug_hierarchy"},
	//TODO: HAVE CODE SCAN SCHEMA FOR NESTED OPTIONS
	"public_bugs.changes":{},
	"public_bugs.attachments":{},
	"public_bugs.attachments.flags":{},
	"private_bugs.changes":{},
	"private_bugs.attachments":{},
	"private_bugs.attachments.flags":{},
	"bugs.changes":{},
	"bugs.attachments":{},
	"bugs.attachments.flags":{},

	"reviews":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/reviews/review"},
	"bug_summary":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/bug_summary/bug_summary"},
	"bug_tags":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/bug_tags/bug_tags"},
	"org_chart":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/org_chart/person"},
	"temp":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":""},
	"telemetry":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/telemetry_agg_valid_201305/data"},
	"raw_telemetry":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9200", "path":"/raw_telemetry/data"},

	"talos":{"host":"http://klahnakoski-es.corp.tor1.mozilla.com:9200", "path":"/datazilla/results"},
	"b2g_tests":{"host":"http://elasticsearch4.bugs.scl3.mozilla.com:9200", "path":"/b2g_tests/results"},

	"perfy":{"host":"http://elasticsearch-private.bugs.scl3.mozilla.com:9200", "path":"/perfy/scores"},
	"local_perfy":{"host":"http://localhost:9200", "path":"/perfy/scores"}

//	"raw_telemetry":{"host":"http://localhost:9200", "path":"/raw_telemetry/data"}
};

// Fallback to public cluster if private fails
ESQuery.INDEXES.private_bugs.alternate = ESQuery.INDEXES.public_bugs;

ESQuery.getColumns=function(indexName){
	var index=ESQuery.INDEXES[indexName];
	if (index.columns===undefined) return [];//DEFAULT BEHAVIOUR IS TO WORK WITH NO KNOWN COLUMNS
	return index.columns;
};//method


//RETURN THE COLUMN DEFINITIONS IN THE GIVEN esProperties OBJECT
ESQuery.parseColumns=function(indexName, parentName, esProperties){
	var columns = [];
	forAllKey(esProperties, function(name, property){
		var fullName=[parentName, name].concatenate(".");

		if (property.type == "nested"){
			//NESTED TYPE IS A NEW TYPE DEFINITION
			var nestedName=indexName+"."+name;
			if (ESQuery.INDEXES[nestedName]===undefined) ESQuery.INDEXES[nestedName]={};
			ESQuery.INDEXES[nestedName].columns=ESQuery.parseColumns(nestedName, parentName, property.properties);
			return;
		}//endif

		if (property.properties !== undefined) {
			var childColumns=ESQuery.parseColumns(indexName, fullName, property.properties);
			columns.appendArray(childColumns);
			return;
		}//endif


		if (property.dynamic !== undefined) return;
		if (property.type === undefined) return;
		if (property.type == "multi_field"){
			property.type = property.fields[name].type;  //PULL DEFAULT TYPE
			forAllKey(property.fields, function(n, p, i){
				if (n==name){
					//DEFAULT
					columns.push({"name":fullName, "type":p.type, "useSource":p.index=="no"});
				}else{
					columns.push({"name":fullName+"\\."+n, "type":p.type, "useSource":p.index=="no"});
				}//endif
			});
			return;
		}//endif


		if (["string", "boolean", "integer", "date", "long", "double"].contains(property.type)){
			columns.push({"name":fullName, "type":property.type, "useSource":property.index=="no"});
			if (property.index_name && name!=property.index_name)
				columns.push({"name":property.index_name, "type":property.type, "useSource":property.index=="no"});
		}else{
			Log.error("unknown type "+property.type);
		}//endif
	});

	//SPECIAL CASE FOR PROPERTIES THAT WILL CAUSE OutOfMemory EXCEPTIONS
	columns.forall(function(c){
		if (indexName=="bugs" && (c.name=="dependson" || c.name=="blocked")) c.useSource=true;
	});


	return columns;
};//method


//ENSURE COLUMNS FOR GIVEN INDEX/QUERY ARE LOADED, AND MVEL COMPILATION WORKS BETTER
ESQuery.loadColumns=function*(query){
	var indexName = null;
	if (typeof(query) == 'string'){
		indexName = query;
	}else{
		indexName = query.from.split(".")[0];
	}//endif

	var indexInfo = ESQuery.INDEXES[indexName];
	if (indexInfo.host===undefined) Log.error("must have host defined");
	var indexPath=indexInfo.path;
	if (indexName=="bugs" && !indexPath.endsWith("/bug_version")) indexPath+="/bug_version";
	if (indexInfo.columns!==undefined)
		yield(null);

	//WE MANAGE ALL THE REQUESTS FOR THE SAME SCHEMA, DELAYING THEM IF THEY COME IN TOO FAST
	if (indexInfo.fetcher === undefined) {
		indexInfo.fetcher=Thread.run(function*(){
			var URL=nvl(query.url, indexInfo.host + indexPath) + "/_mapping";
			var path = parse.URL(URL).pathname.split("/").rightBut(1);
			var pathLength = path.length - 1;  //ASSUME /indexname.../_mapping

			try{
				var schema = yield(Rest.get({
					"url":URL,
					"doNotKill":true        //WILL NEED THE SCHEMA EVENTUALLY
				}));
			} catch(e){
				indexPath = indexInfo.alternate.path;
				URL=nvl(query.url, indexInfo.alternate.host + indexPath) + "/_mapping";
				path = parse.URL(URL).pathname.split("/").rightBut(1);
				pathLength = path.length - 1;  //ASSUME /indexname.../_mapping
				console.log( 'Executing fallback to ' + indexInfo.alternate.host + indexPath );
				try{
					var schema = yield(Rest.get({
						"url":URL,
						"doNotKill":true        //WILL NEED THE SCHEMA EVENTUALLY
					}));
				} catch(e){
					if (e.contains(Thread.Interrupted)){
						Log.warning("Tried to kill, but ignoring");
						yield (Thread.suspend());
					}//endif
					Log.error("problem with call to load columns", e);
				}
			}//try

			if (pathLength == 1){  //EG http://host/_mapping
				//CHOOSE AN INDEX
				prefix = URL.split("/")[3];
				indicies = Object.keys(schema);
				if (indicies.length == 1){
					schema = schema[indicies[0]]
				} else{
					schema = mapAllKey(function(k, v){
						if (k.startsWith(prefix)) return v;
					})[0]
				}//endif
			}//endif

			if (pathLength <= 2){//EG http://host/indexname/typename/_mapping
				var types = Object.keys(schema);
				if (types.length == 1){
					schema = schema[types[0]];
				} else if (schema[indexPath.split("/")[2]] !== undefined){
					schema = schema[indexPath.split("/")[2]];
				} else{
					schema = schema[types[0]];
				}//endif
			}//endif

			var properties = schema.properties
			indexInfo.columns = ESQuery.parseColumns(indexName, undefined, properties);

			yield(null);
		});
	}//endif

	yield (Thread.join(indexInfo.fetcher));
	yield (null);
};//method



ESQuery.run=function*(query){
	yield (ESQuery.loadColumns(query));
	var esq=new ESQuery(query);

	 if (Object.keys(esq.esQuery.facets).length==0 && esq.esQuery.size==0)
			Log.error("ESQuery is sending no facets");


	var output=yield (esq.run());

	Map.copy(Qb.query.prototype, output);

	if (output===undefined)
		Log.error("what happened here?");
	yield output;
};


ESQuery.prototype.run = function*(){
	if (!this.query.url){
		var indexInfo=ESQuery.INDEXES[this.query.from.split(".")[0]];
		if (indexInfo.host===undefined) Log.error("must have host defined");
		this.query.url=indexInfo.host+indexInfo.path;
	}//endif


	if (!this.query.url.endsWith("/_search")) this.query.url+="/_search";  //WHEN QUERIES GET RECYCLED, THEIR url IS SOMETIMES STILL AROUND
	var postResult;
	if (ESQuery.DEBUG) Log.note(CNV.Object2JSON(this.esQuery));

	if ((this.query.select instanceof Array || this.query.edges.length>0) && Object.keys(this.esQuery.facets).length==0 && this.esQuery.size==0)
		Log.error("ESQuery is sending no facets");

	try{
		try{
			postResult=yield (Rest.post({
				url: this.query.url,
				data: CNV.Object2JSON(this.esQuery),
				dataType: "json",
				headers:{
					"Accept-Encoding": "gzip,deflate"//Accept-Encoding: gzip,deflate
	//				"http.compress":"true"
				},
				timeout:this.query.timeout
			}));

			if (postResult){

			}//endif
		}catch(e){
			if (!e.contains(Exception.TIMEOUT)){
				throw e;
			}else{
				Log.action("Query timeout");
				this.nextDelay = nvl(this.nextDelay, 500) * 2;
				yield (Thread.sleep(this.nextDelay));
				Log.action("Retrying Query...");
				//TODO: TRY TO DO TAIL-RECURSION
				var output=yield (this.run());
				yield output;
			}//endif
		}//try

		var self=this;
		if (postResult.facets) forAllKey(postResult.facets, function(facetName, f){
			if (f._type=="statistical") return;
			if (!f.terms) return;

			if (!ESQuery.DEBUG && f.terms.length==self.query.essize){
				Log.error("Not all data delivered ("+f.terms.length+"/"+f.total+") try smaller range");
			}//endif
		});

		if (postResult._shards.failed>0){
			Log.action(postResult._shards.failed+"of"+postResult._shards.total+" shards failed.");
			this.nextDelay=nvl(this.nextDelay, 500)*2;
			yield (Thread.sleep(this.nextDelay));
			Log.action("Retrying Query...");
			//TODO: TRY TO DO TAIL-RECURSION
			output=yield (this.run());
			yield output;
		}//endif
	}catch(e){
		Log.error("Error with ESQuery", e);
	}//try

//	var a=Log.action("Process ES Terms", true);
	if (this.esMode == "fields"){
		this.fieldsResults(postResult);
	}else if (this.esMode == "terms"){
		this.termsResults(postResult);
	} else if (this.esMode == "setop"){
		this.mvelResults(postResult);
	} else if (this.esMode == "terms_stats"){
		this.terms_statsResults(postResult);
	} else{//statistical
		this.statisticalResults(postResult);
	}//endif
//	Log.actionDone(a);


	yield this.query;
};//method


ESQuery.prototype.kill = function(){
	Log.warning("do not need to call this anymore");
//
//	if (this.esRequest!==undefined){
//		try{
//			this.esRequest.abort();
//		}catch(e){
//
//		}//try
//		this.esRequest=undefined;
//	}//endif
//	this.callack=undefined;
};


//ACCEPT MULTIPLE ESQuery OBJECTS AND MERGE THE FACETS SO ONLY ONE CALL IS MADE TO ES
ESQuery.merge=function(){
	for(var i=0;i<arguments.length;i++){


	}//for





};//method






ESQuery.prototype.compile = function(){
	if (this.query.essize===undefined) this.query.essize=200000;
	if (ESQuery.DEBUG) this.query.essize=100;

	this.columns = Qb.compile(this.query, ESQuery.INDEXES[this.query.from.split(".")[0]].columns, true);


	var esFacets;
	if (this.columns[0].name=="Team"){
		Log.note("");
	}


	//THESE SMOOTH EDGES REQUIRE ALL DATA (SETOP)
	var extraSelect=[];
	this.query.edges.forall(function(e){
		if (e.domain !== undefined && Qb.domain.ALGEBRAIC.contains(e.domain.type) &&  e.domain.interval == "none"){
			extraSelect.append({"name":e.name, "value":e.value});
		}//endif
	});


	if (extraSelect.length == this.query.edges.length){
		this.termsEdges = [];
		this.select = Array.newInstance(this.query.select);
		this.select.appendArray(extraSelect)
	}else{
		this.termsEdges = this.query.edges.copy();
		this.select = Array.newInstance(this.query.select);
	}//endif


	if (this.termsEdges.length==0){
		//NO EDGES IMPLIES SIMPLER QUERIES: EITHER A SET OPERATION, OR RETURN SINGLE AGGREGATE
		if (this.select[0].aggregate==="none"){  //"none" IS GIVEN TO undefined OPERATIONS DURING COMPILE
			this.esMode="setop";
			this.compileSetOp();
			return;
		}else{
			var value=this.select[0].value;
			for(var k=this.select.length;k--;){
				if (this.select[k].value!=value) Log.error("ES Query with multiple select columns must all have the same value");
			}//for

			if (this.query.select===undefined || (this.select.length==1 && this.select[0].aggregate=="count")){
				this.esMode="terms";
				this.esQuery = this.buildESCountQuery(value);
				return;
			}else{
				this.esMode="statistical";
				this.esQuery=this.buildESStatisticalQuery(value);
				return;
			}//endif
		}//endif
	}//endif


	//PICK FIRST AND ONLY SELECT
	if (this.select.length>1){
		var allSame=true;
		for(var s=this.select.length;s--;){
			if (this.select[s].value!=this.select[0].value) allSame=false;
		}//for
		if (!allSame) Log.error("Can not have an array of select columns, only one allowed");
	}else if (this.select.length==0){
		this.select=undefined;
	}//endif

	if (this.query.where)
		Log.error("ESQuery does not support the where clause, use esfilter instead");

	//VERY IMPORTANT!! ES CAN ONLY USE TERM PACKING ON terms FACETS, THE OTHERS WILL REQUIRE EVERY PARTITION BEING A FACET
	this.esMode = "terms_stats";
	if (this.query.select===undefined || (this.select.length==1 && this.select[0].aggregate=="count")){
		this.esMode="terms";
	}//endif
	if (ESQuery.agg2es[this.select[0].aggregate]===undefined){
		Log.error("ES can not aggregate "+this.select[0].name+" because '"+this.select[0].aggregate+"' is not a recognized aggregate");
	}//endif

	this.facetEdges=[];	//EDGES THAT WILL REQUIRE A FACET FOR EACH PART

	//A SPECIAL EDGE IS ONE THAT HAS AN UNDEFINED NUMBER OF PARTITIONS AT QUERY TIME
	//FIND THE specialEdge, IF ONE
	this.specialEdge = null;
	for(var f = 0; f < this.termsEdges.length; f++){
		if ((Qb.domain.KNOWN.contains(this.termsEdges[f].domain.type))){
			for(var p = this.termsEdges[f].domain.partitions.length; p--;){
				this.termsEdges[f].domain.partitions[p].dataIndex = p;
			}//for

			//FACETS ARE ONLY REQUIRED IF SQL JOIN ON DOMAIN IS REQUIRED (RANGE QUERY)
			//OR IF WE ARE NOT SIMPLY COUNTING
			//OR IF NO SCRIPTING IS ALLOWED (SOME OTHER CODE IS REPOSIBLE FOR SETTING isFacet)
			//OR IF WE JUST WANT TO FORCE IT :)
			if (this.termsEdges[f].range || this.esMode!="terms" || this.termsEdges[f].domain.isFacet){
				this.facetEdges.push(this.termsEdges[f]);
				this.termsEdges.splice(f, 1);
				f--;
			}//endif
		} else if (this.esMode=="terms"){
			//NO SPECIAL EDGES FOR terms FACETS (ALL ARE SPECIAL!!)
		} else{
			if (this.specialEdge != null) Log.error("There is more than one open-ended edge: this can not be handled");
			this.specialEdge = this.termsEdges[f];
			this.termsEdges.splice(f, 1);
			f--;
		}//endif
	}//for

	if (this.specialEdge == null && this.esMode=="terms_stats"){
		this.esMode = "statistical";
	}//endif

	this.esQuery = this.buildESQuery();

	esFacets = this.buildFacetQueries();

	for(var i = 0; i < esFacets.length; i++){
		this.esQuery.facets[esFacets[i].name] = esFacets[i].value;
	}//for

};


// RETURN LIST OF ALL EDGE QUERIES
ESQuery.prototype.buildFacetQueries = function(){
	var output = [];

	var esFacets = this.getAllEdges(0);
	for(var i = 0; i < esFacets.length; i++){
		var condition = [];
		var name = "";
		var constants=[];
		if (this.facetEdges.length==0){
			name="default";
		}else{
			for(var f = 0; f < this.facetEdges.length; f++){
				if (name != "") name += ",";
				name += esFacets[i][f].dataIndex;
				condition.push(ESQuery.buildCondition(this.facetEdges[f], esFacets[i][f], this.query));
				constants.push({"name":this.facetEdges[f].domain.name, "value":esFacets[i][f]});
			}//for
		}//for
		var q = {"name":name};

		var value=this.compileEdges2Term(constants);

		if (this.esMode=="terms"){
			if (value.type=="count"){
				q.value={
					"terms":{
						"field":this.select[0].value, //PICK WHATEVER VALUE WE CAN
						"size": 0  //DO NOT COUNT, THE SUMMARY WILL DO FINE
					}
				};
			}else if (value.type=="field"){
				q.value={
					"terms":{
						"field":value.value,
						"size": this.query.essize
					}
				};
			}else{
				q.value={
					"terms":{
						"script_field":value.value,
						"size": this.query.essize
					}
				};
			}//endif
		}else if (this.esMode == "terms_stats"){
			if (value.type=="field"){
				q.value = {
					"terms_stats":{
						"key_field":value.field,
						"value_field":value.value,
						"size":this.query.essize
					}
				};
			}else{
				q.value = {
					"terms_stats":{
						"key_field":value.field,
						"value_script":value.value,
						"size":this.query.essize
					}
				};

			}
		} else{//statistical
			if (value.type=="field"){
				q.value = {
					"statistical":{
						"field":value.value
					}
				};
			}else{
				q.value = {
					"statistical":{
						"script":value.value
					}
				};
			}
		}//endif

		if (condition.length>0) q.value.facet_filter={"and":condition};

		output.push(q);
	}//for
	return output;
};//method



//RETURN ALL PARTITION COMBINATIONS:  A LIST OF ORDERED TUPLES
ESQuery.prototype.getAllEdges = function(edgeDepth){
	if (edgeDepth == this.facetEdges.length) return [
		[]
	];
	var edge = this.facetEdges[edgeDepth];

	var output = [];
	var partitions = edge.domain.partitions;
	for(var i = 0; i < partitions.length; i++){
		var deeper = this.getAllEdges(edgeDepth + 1);
		for(var o = 0; o < deeper.length; o++){
			deeper[o].unshift(partitions[i]);
			output.push(deeper[o]);
		}//for
	}//for
	return output;
};//method





//RETURN AN ES FILTER OBJECT
ESQuery.buildCondition = function(edge, partition, query){
	//RETURN AN ES FILTER OBJECT
	var output = {};

	if (edge.domain.isFacet){
		//MUST USE THIS' esFacet
		var condition=nvl(partition.esfilter, {"and":[]});

		if (partition.min!==undefined && partition.max!==undefined && MVEL.isKeyword(edge.value)){
			condition.and.push({
				"range":Map.newInstance(edge.value, {"gte":partition.min, "lt":partition.max})
			})
		}

		//ES WILL FREAK OUT IF WE SEND {"not":{"and":x}} (OR SOMETHING LIKE THAT)
//		var parts=edge.domain.partitions;
//		for(var i=0;i<parts.length;i++){
//			var p=parts[i];
//			if (p==partition) break;
//			condition.and.push({"not":p.esfilter});
//		}//for

		return ESFilter.simplify(condition);
	} else if (edge.range){
		//THESE REALLY NEED FACETS TO PERFORM THE JOIN-TO-DOMAIN
		//USE MVEL CODE
		if (Qb.domain.ALGEBRAIC.contains(edge.domain.type)){
			output={"and":[]};

			if (edge.range.mode!==undefined && edge.range.mode=="inclusive"){
				//IF THE range AND THE partition OVERLAP, THEN MATCH IS MADE
				if (MVEL.isKeyword(edge.range.min)){
					output.and.push({"range":Map.newInstance(edge.range.min,{"lt":MVEL.Value2Value(partition.max)})});
				}else{
					//WHOA!! SUPER SLOW!!
					output.and.push({"script":{"script":MVEL.compile.expression(
						edge.range.min + " < " + MVEL.Value2MVEL(partition.max)
					, query)}})
				}//endif

				if (MVEL.isKeyword(edge.range.max)){
					output.and.push({"or":[
						{"missing":{"field":edge.range.max}},
						{"range":Map.newInstance(edge.range.max,{"gt":MVEL.Value2Value(partition.min)})}
					]});
				}else{
					//WHOA!! SUPER SLOW!!
					output.and.push({"script":{"script":MVEL.compile.expression(
						edge.range.max + " > " + MVEL.Value2MVEL(partition.min)
					, query)}})
				}//endif
			}else{
				//SNAPSHOT - IF range INCLUDES partition.min, THEN MATCH IS MADE
				if (MVEL.isKeyword(edge.range.min)){
					output.and.push({"range":Map.newInstance(edge.range.min,{"lte":MVEL.Value2Value(partition.min)})});
				}else{
					//WHOA!! SUPER SLOW!!
					output.and.push({"script":{"script":MVEL.compile.expression(
						edge.range.min + "<=" + MVEL.Value2MVEL(partition.min)
					, query)}})
				}//endif

				if (MVEL.isKeyword(edge.range.max)){
					output.and.push({"or":[
						{"missing":{"field":edge.range.max}},
						{"range":Map.newInstance(edge.range.max,{"gte":MVEL.Value2Value(partition.min)})}
					]});
				}else{
					//WHOA!! SUPER SLOW!!
					output.and.push({"script":{"script":MVEL.compile.expression(
						MVEL.Value2MVEL(partition.min) +" <= "+ edge.range.max
					, query)}})
				}//endif
			}//endif
			return output;
		} else {
			Log.error("Do not know how to handle range query on non-continuous domain");
		}//endif
	}else 	if (edge.value===undefined){
		//MUST USE THIS' esFacet, AND NOT(ALL THOSE ABOVE)
		return ESFilter.simplify(partition.esfilter);
	}else if (MVEL.isKeyword(edge.value)){
		//USE FAST ES SYNTAX
		if (Qb.domain.ALGEBRAIC.contains(edge.domain.type)){
			output.range = {};
			output.range[edge.value] = {"gte":MVEL.Value2Query(partition.min), "lt":MVEL.Value2Query(partition.max)};
		} else if (edge.domain.type == "set"){
			if (partition.value!==undefined){
				if (partition.value!=edge.domain.getKey(partition)) Log.error("please ensure the key attribute of the domain matches the value attribute of all partitions, if only because we are now using the former");
				//DEFAULT TO USING THE .value ATTRIBUTE, IF ONLY BECAUSE OF LEGACY REASONS
				output.term = Map.newInstance(edge.value, partition.value);
			}else{
				output.term = Map.newInstance(edge.value, edge.domain.getKey(partition));
			}//endif
		} else if (edge.domain.type=="default"){
			output.term = {};
			output.term[edge.value] = partition.value;
		} else{
			Log.error("Edge \"" + edge.name + "\" is not supported");
		}//endif
		return output;
	} else{
		//USE MVEL CODE
		if (Qb.domain.ALGEBRAIC.contains(edge.domain.type)){
			output.script = {script:edge.value + ">=" + MVEL.Value2MVEL(partition.min) + " && " + edge.value + "<" + MVEL.Value2MVEL(partition.max)};
		} else {//if (edge.domain.type == "set"){
			output.script = {script:"( "+edge.value + " ) ==" + MVEL.Value2MVEL(partition.value)};
		}//endif
		output.script.script=MVEL.compile.addFunctions(output.script.script);
		return output;
	}//endif

};

ESQuery.prototype.buildESQuery = function(){
	var where;
	if (this.query.where===undefined) 		where=ESQuery.TrueFilter;
	if (typeof(this.query.where)!="string")	where=ESQuery.TrueFilter; //NON STRING WHERE IS ASSUMED TO BE PSUDO-esFILTER (FOR CONVERSION TO MVEL)
	if (typeof(this.query.where)=="string"){
		if (where.trim()=="true"){
			where=ESQuery.TrueFilter;
		}else{
			where={"script":{"script":this.query.where}};
		}//endif
	}//endif

	var output = {
		"query":{
			"filtered":{
				"query": {
					"match_all":{}
				},
				"filter":{
					"and":[
						where
					]
				}
			}
		},
		"from" : 0,
		"size" : ESQuery.DEBUG ? 100 : 0,
		"sort" : [],
		"facets":{
		}
	};
	if (this.query.esfilter !== undefined) output.query.filtered.filter.and.push(this.query.esfilter);
	return output;
};//method



//RETURN SINGLE COUNT
ESQuery.prototype.buildESCountQuery=function(value){
	 //REGISTER THE DECODE FUNCTION
	this.term2Parts=function(term){
		return [];
	};

	var output=this.buildESQuery();
	if (MVEL.isKeyword(value)){
		//MAKE SURE value EXISTS
		output.query.filtered.filter.and.push({"exists":{"field":value}});
	}else{
		//COMPLICATED value IS PROBABLY A SCRIPT, USE IT
		output.facets["0"]={
			"terms":{
				"script_field":MVEL.compile.expression(value, this.query),
				"size": 200000
			}
		};
	}//endif
	return output;
};


//RETURN A SINGLE SET OF STATISTICAL VALUES, NO GROUPING
ESQuery.prototype.buildESStatisticalQuery=function(value){
	var output = this.buildESQuery();

	if (MVEL.isKeyword(value)){
		output.facets["0"] = {
			"statistical":{
				"field":value
			}
		};
	}else{
		output.facets["0"] = {
			"statistical":{
				"script":MVEL.compile.expression(value, this.query)
			}
		};
	}//endif

	return output;
};//method


//GIVE MVEL CODE THAT REDUCES A UNIQUE TUPLE OF PARTITIONS DOWN TO A UNIQUE TERM
//GIVE JAVASCRIPT THAT WILL CONVERT THE TERM BACK INTO THE TUPLE
//RETURNS TUPLE OBJECT WITH "type" and "value" ATTRIBUTES.
//"type" CAN HAVE A VALUE OF "script", "field" OR "count"
//CAN USE THE constants (name, value pairs)
ESQuery.prototype.compileEdges2Term=function(constants){
	var self=this;
	var edges=this.termsEdges;

	if (edges.length==0){
		if (this.specialEdge){
			var specialEdge=this.specialEdge;
			this.term2Parts=function(term){
				return [specialEdge.domain.getPartByKey(term)];
			};

			//ONLY USED BY terms_stats, AND VALUE IS IN THE SELECT CLAUSE
			if (!MVEL.isKeyword(specialEdge.value)) Log.error("Can not handle complex edge value with "+this.select[0].aggregate);
			if (MVEL.isKeyword(this.select[0].value)){
				return {"type":"field", "field":specialEdge.value, "value":this.select[0].value};
			}else{
				return {"type":"script", "field":specialEdge.value, "value":MVEL.compile.expression(this.select[0].value, this.query, constants)};
			}//endif
		}else if (this.esMode=="statistical"){
			//REGISTER THE DECODE FUNCTION
			this.term2Parts=function(term){
				return [];
			};
			if (MVEL.isKeyword(this.select[0].value)){
				return {"type":"field", "value":this.select[0].value};
			}else{
				return {"type":"script", "value":MVEL.compile.expression(this.select[0].value, this.query, constants)};
			}//endif
		}else{
			//REGISTER THE DECODE FUNCTION
			this.term2Parts=function(term){
				return [];
			};
			return {"type":"count", "value":"1"};
		}//endif
	}//endif

	//IF THE QUERY IS SIMPLE ENOUGH, THEN DO NOT USE TERM PACKING
	if (edges.length==1 && ["set", "default"].contains(edges[0].domain.type)){
		//THE TERM RETURNED WILL BE A MEMBER OF THE GIVEN SET
		this.term2Parts=function(term){
			return [edges[0].domain.getPartByKey(term)];
		};

		if (edges[0].value===undefined && edges[0].domain.partitions!==undefined){
			var script=MVEL.Parts2TermScript(
				self.query.from,
				edges[0].domain
			);
			return {"type":"script", "value":MVEL.compile.expression(script, this.query, constants)};
		}//endif

		if (edges[0].esscript){
			return {"type":"script", "value":MVEL.compile.addFunctions(edges[0].esscript)};
		}else if (MVEL.isKeyword(edges[0].value)){
			return {"type":"field", "value":edges[0].value};
		}else{
			return {"type":"script", "value":MVEL.compile.expression(edges[0].value, this.query, constants)};
		}//endif
	}//endif

	var mvel=undefined;     //FUNCTION TO PACK TERMS
	var fromTerm2Part=[];   //UNPACK TERMS BACK TO PARTS
	edges.forall(function(e, i){
		if (mvel===undefined) mvel="''+"; else mvel+="+'|'+";

		if (e.value===undefined && e.domain.field!==undefined){
			e.value=e.domain.field;
		}//endif

		var t;
		if (e.domain.type=="time"){
			t=ESQuery.compileTime2Term(e);
		}else if (e.domain.type=="duration"){
			t=ESQuery.compileDuration2Term(e);
		}else if (Qb.domain.ALGEBRAIC.contains(e.domain.type)){
			t=ESQuery.compileNumeric2Term(e);
		}else if (e.domain.type=="set" && e.domain.field===undefined){
			t={
				"toTerm":MVEL.Parts2Term(
					self.query.from,
					e.domain
				),
				"fromTerm":function(term){
					return e.domain.getPartByKey(term);
				}
			};
		}else{
			t=ESQuery.compileString2Term(e);
		}//for
		if (t.toTerm.body===undefined) Log.error();

		fromTerm2Part.push(t.fromTerm);
		mvel=t.toTerm.head+mvel+t.toTerm.body;
	});

	//REGISTER THE DECODE FUNCTION
	this.term2Parts=function(term){
		var output=[];
		var terms=term.split('|');
		for(var i=0;i<terms.length;i++){
			output.push(fromTerm2Part[i](terms[i]));
		}//for
		return output;
	};

	return {"type":"script", "value":MVEL.compile.expression(mvel, this.query, constants)};
};


//RETURN MVEL CODE THAT MAPS TIME AND DURATION DOMAINS DOWN TO AN INTEGER AND
//AND THE JAVASCRIPT THAT WILL TURN THAT INTEGER BACK INTO A PARTITION (INCLUDING NULLS)
ESQuery.compileTime2Term=function(edge){
	if (edge.esscript) Log.error("edge script not supported yet");

	//IS THERE A LIMIT ON THE DOMAIN?
	var numPartitions=edge.domain.partitions.length;
	var value=edge.value;
	if (MVEL.isKeyword(value)) value="doc[\""+value+"\"].value";


	var nullTest=ESQuery.compileNullTest(edge);
	var ref=nvl(edge.domain.min, edge.domain.max, new Date(2000,0,1));

	var partition2int;
	if (edge.domain.interval.month>0){
		var offset=ref.subtract(ref.floorMonth(), Duration.DAY).milli;
		if (offset>Duration.DAY.milli*28) offset=ref.subtract(ref.ceilingMonth(), Duration.DAY).milli;
		partition2int="milli2Month("+value+", "+MVEL.Value2MVEL(offset)+")";
		partition2int="(("+nullTest+") ? 0 : "+partition2int+")";

		int2Partition=function(value){
			if (aMath.round(value)==0) return edge.domain.NULL;

			var d=new Date((""+value).left(4), (""+value).right(2), 1);
			d=d.addMilli(offset);
			return edge.domain.getPartByKey(d);
		};
	}else{
		partition2int="Math.floor(("+value+"-"+MVEL.Value2MVEL(ref)+")/"+edge.domain.interval.milli+")";
		partition2int="(("+nullTest+") ? "+numPartitions+" : "+partition2int+")";

		int2Partition=function(value){
			if (aMath.round(value)==numPartitions) return edge.domain.NULL;
			return edge.domain.getPartByKey(ref.add(edge.domain.interval.multiply(value)));
		};

	}//endif

	return {"toTerm":{"head":"", "body":partition2int}, "fromTerm":int2Partition};
};

//RETURN MVEL CODE THAT MAPS DURATION DOMAINS DOWN TO AN INTEGER AND
//AND THE JAVASCRIPT THAT WILL TURN THAT INTEGER BACK INTO A PARTITION (INCLUDING NULLS)
ESQuery.compileDuration2Term=function(edge){
	if (edge.esscript) Log.error("edge script not supported yet");

	//IS THERE A LIMIT ON THE DOMAIN?
	var numPartitions=edge.domain.partitions.length;
	var value=edge.value;
	if (MVEL.isKeyword(value)) value="doc[\""+value+"\"].value";

	var ref=nvl(edge.domain.min, edge.domain.max, Duration.ZERO);
	var nullTest=ESQuery.compileNullTest(edge);


	var ms=edge.domain.interval.milli;
	if (edge.domain.interval.month>0)
		ms=Duration.YEAR.milli/12*edge.domain.interval.month;

	var partition2int="Math.floor(("+value+"-"+MVEL.Value2MVEL(ref)+")/"+ms+")";
		partition2int="(("+nullTest+") ? "+numPartitions+" : "+partition2int+")";

	int2Partition=function(value){
		if (aMath.round(value)==numPartitions) return edge.domain.NULL;
		return edge.domain.getPartByKey(ref.add(edge.domain.interval.multiply(value)));
	};

	return {"toTerm":{"head":"", "body":partition2int}, "fromTerm":int2Partition};
};

//RETURN MVEL CODE THAT MAPS THE numeric DOMAIN DOWN TO AN INTEGER AND
//AND THE JAVASCRIPT THAT WILL TURN THAT INTEGER BACK INTO A PARTITION (INCLUDING NULLS)
ESQuery.compileNumeric2Term=function(edge){
	if (edge.script!==undefined) Log.error("edge script not supported yet");

	if (edge.domain.type!="numeric" && edge.domain.type!="count") Log.error("can only translate numeric domains");

	var numPartitions=edge.domain.partitions.length;
	var value=edge.value;
	if (MVEL.isKeyword(value)) value="doc[\""+value+"\"].value";

	var ref, nullTest, partition2int, int2Partition;
	if (edge.domain.max===undefined){
		if (edge.domain.min===undefined){
			ref=0;
			partition2int="Math.floor("+value+")/"+MVEL.Value2MVEL(edge.domain.interval)+")";
			nullTest="false";
		}else{
			ref=MVEL.Value2MVEL(edge.domain.min);
			partition2int="Math.floor(("+value+"-"+ref+")/"+MVEL.Value2MVEL(edge.domain.interval)+")";
			nullTest=""+value+"<"+ref;
		}//endif
	}else if (edge.domain.min===undefined){
		ref=MVEL.Value2MVEL(edge.domain.max);
		partition2int="Math.floor(("+value+"-"+ref+")/"+MVEL.Value2MVEL(edge.domain.interval)+")";
		nullTest=""+value+">="+ref;
	}else{
		var top=MVEL.Value2MVEL(edge.domain.max);
			ref=MVEL.Value2MVEL(edge.domain.min);
		partition2int="Math.floor(("+value+"-"+ref+")/"+MVEL.Value2MVEL(edge.domain.interval)+")";
		nullTest="("+value+"<"+ref+") || ("+value+">="+top+")";
	}//endif

	partition2int="(("+nullTest+") ? "+numPartitions+" : "+partition2int+")";
	var offset=CNV.String2Integer(ref);
	int2Partition=function(value){
		if (aMath.round(value)==numPartitions) return edge.domain.NULL;
		return edge.domain.getPartByKey((value * edge.domain.interval) + offset);
	};

	return {"toTerm":{"head":"", "body":partition2int}, "fromTerm":int2Partition};
};



ESQuery.compileString2Term=function(edge){
	if (edge.esscript) Log.error("edge script not supported yet");

	var value=edge.value;
	if (MVEL.isKeyword(value)) value="getDocValue(\""+value+"\")";

	return {
		"toTerm":{"head":"", "body":'Value2Pipe('+value+')'},
		"fromTerm":function(value){
			return edge.domain.getPartByKey(CNV.Pipe2Value(value));
		}
	};
};//method


//EXPECT A ElasticSearch DEFINED EDGE, AND RETURN EXPRESSION TO RETURN EDGE NAMES
ESQuery.compileES2Term=function(edge){
//		"var keywords = concat(_source.keywords);\n"+
//		"var white = _source.status_whiteboard;\n"+
//		"     if (keywords.indexOf(\"sec-critical\")>=0 ) \"critical\"; "+
//		"else if (   white.indexOf(\"[sg:critical]\")   >=0 ) \"critical\"; "+
//		"else if (keywords.indexOf(\"sec-high\")    >=0 ) \"high\"; "+
//		"else if (   white.indexOf(\"[sg:high]\")   >=0 ) \"high\"; "+
//		"else if (keywords.indexOf(\"sec-moderate\")>=0 ) \"moderate\"; "+
//		"else if (   white.indexOf(\"[sg:moderate]\")    >=0 ) \"moderate\"; "+
//		"else if (keywords.indexOf(\"sec-low\")     >=0 ) \"low\"; "+
//		"else if (   white.indexOf(\"[sg:low]\")    >=0 ) \"low\"; "+
//		"else \"other\";",
//		//"else \"other\"; ",  CAN NOT DO THIS (SPACE AT AND OF else RESULTS IN null VALUES RETURNED
//		"allowNulls":false,
//		"domain":{"type":"set", "partitions":["critical", "high", "moderate", "low"]}},



};//method




//RETURN A MVEL EXPRESSION THAT WILL EVALUATE TO true FOR OUT-OF-BOUNDS
ESQuery.compileNullTest=function(edge){
	if (!Qb.domain.ALGEBRAIC.contains(edge.domain.type))
		Log.error("can only translate time and duration domains");

	//IS THERE A LIMIT ON THE DOMAIN?
	var value=edge.value;
	if (MVEL.isKeyword(value)) value="doc[\""+value+"\"].value";

	var top, bot, nullTest;
	if (edge.domain.max===undefined){
		if (edge.domain.min===undefined) return false;
		bot=MVEL.Value2MVEL(edge.domain.min);
		nullTest=""+value+"<"+bot;
	}else if (edge.domain.min===undefined){
		top=MVEL.Value2MVEL(edge.domain.max);
		nullTest=                         ""+value+">="+top;
	}else{
		top=MVEL.Value2MVEL(edge.domain.max);
		bot=MVEL.Value2MVEL(edge.domain.min);
		nullTest="("+value+"<"+bot+") || ("+value+">="+top+")";
	}//endif

	return nullTest;
};






ESQuery.prototype.termsResults=function(data){
	var self=this;

	if (data.facets === undefined || data.facets.length==0){
		//SIMPLE ES QUERY
		if (this.query.select instanceof Array){
			Log.error("TODO: implement be (pull fields)")
		}else if (this.select[0].aggregate=="count"){
			if (this.query.edges.length>0){
				Log.error("not expected, expecting facets");
			}//endif
			this.query.cube=data.hits.total
			return;
		}else{
			Log.error("Do not know how to handle simple, yet (hint pull fields)")
		}//endif
	}//endif



	//THE FACET EDGES MUST BE RE-INTERLACED WITH THE PACKED EDGES

	//GETTING ALL PARTS WILL EXPAND THE EDGES' DOMAINS
	//REALLY WE SHOULD ONLY BE INSPECTING THE specialEdge, WHICH IS THE ONLY UNKNOWN DOMAIN
	//BUT HOW TO UNPACK IT FROM THE term FASTER IS UNKNOWN
	var facetNames = Object.keys(data.facets);
	for(var k = 0; k < facetNames.length; k++){
		var terms=data.facets[facetNames[k]].terms;
		for(var i=0;i<terms.length;i++){
			this.term2Parts(terms[i].term);
		}//for
	}//for

	//NUMBER ALL EDGES FOR Qb INDEXING
	for(var f=0;f<this.query.edges.length;f++){
		this.query.edges[f].index=f;
		var parts=this.query.edges[f].domain.partitions;
		var p=0;
		for(;p<parts.length;p++){
			parts[p].dataIndex=p;
		}//for
		this.query.edges[f].domain.NULL.dataIndex=p;
	}//for



	//MAKE CUBE
	var select=this.query.select;
	if (select===undefined) select=[];
	var cube= Qb.cube.newInstance(this.query.edges, 0, select);


	//FILL CUBE
	//PROBLEM HERE IS THE INTERLACED EDGES
	for(var k = 0; k < facetNames.length; k++){
		var coord = facetNames[k].split(",");
		var facet = data.facets[facetNames[k]];

		if (this.termsEdges.length==0){
			//EXPECTING ZERO TERMS, JUST facet.total
			//MAKE THE INSERT LIST
			parts = this.facetEdges.map(function(f,i){
				return f.domain.partitions[coord[i]];
			});

			var d = cube;
			var t = 0;
			var length = parts.length;
			if (select instanceof Array){
				for(; t < length; t++){
					if (parts[t].dataIndex == d.length) continue;  //IGNORE NULLS
					d = d[parts[t].dataIndex];
					if (d === undefined) continue;		//WHEN NULLS ARE NOT ALLOWED d===undefined
				}//for
				for(var s = 0; s < select.length; s++){
					d[select[s].name] = facet.total
				}//for
			} else if (length == 0){
				cube = terms[i].count;
			} else{
				length--;
				for(; t < length; t++){
					if (parts[t].dataIndex == d.length) continue;  //IGNORE NULLS
					d = d[parts[t].dataIndex];
					if (d === undefined) continue;		//WHEN NULLS ARE NOT ALLOWED d===undefined
				}//for
				if (d[parts[t].dataIndex] === undefined)
					continue;			//WHEN NULLS ARE NOT ALLOWED d===undefined
				d[parts[t].dataIndex] = facet.total;
			}//endif
			continue;
		}//endif

		//EXPECTING ACTUAL TERMS
		//MAKE THE INSERT LIST
		var interlaceList=[];
		this.facetEdges.forall(function(f,i){
			interlaceList.push({"index":f.index, "value": f.domain.partitions[coord[i]]});
		});

		var terms = facet.terms;
		II: for(var i = 0; i < terms.length; i++){
			var parts = this.term2Parts(terms[i].term);
			for(var j = 0; j < interlaceList.length; j++){
				parts.insert(interlaceList[j].index, interlaceList[j].value);
			}//for
			//INTERLACE DONE: NOW parts SHOULD CORRESPOND WITH this.query.edges

			var d = cube;
			var t = 0;
			var length = parts.length;
			if (select instanceof Array){
				for(; t < length; t++){
					if (parts[t].dataIndex == d.length) continue II;  //IGNORE NULLS
					d = d[parts[t].dataIndex];
					if (d === undefined) continue II;		//WHEN NULLS ARE NOT ALLOWED d===undefined
				}//for
				for(var s = 0; s < select.length; s++){
					d[select[s].name] = terms[i][ESQuery.agg2es[select[s].aggregate]];
				}//for
			} else if (length == 0){
				cube = terms[i].count;
			} else{
				length--;
				for(; t < length; t++){
					if (parts[t].dataIndex == d.length) continue II;  //IGNORE NULLS
					d = d[parts[t].dataIndex];
					if (d === undefined) continue II;		//WHEN NULLS ARE NOT ALLOWED d===undefined
				}//for
				if (d[parts[t].dataIndex] === undefined)
					continue;			//WHEN NULLS ARE NOT ALLOWED d===undefined
				d[parts[t].dataIndex] = terms[i].count;
			}//endif
		}//for
	}//for

	this.query.cube=cube;
};

//MAP THE SELECT OPERATION NAME TO ES FACET AGGREGATE NAME
ESQuery.agg2es = {
	"one":"count",
	"sum":"total",
	"add":"total",
	"count":"count",
	"maximum":"max",
	"minimum":"min",
	"max":"max",
	"min":"min",
	"mean":"mean",
	"average":"mean",
	"avg":"mean",
	"N":"count",
	"X0":"count",
	"X1":"total",
	"X2":"sum_of_squares",
	"std":"std_deviation",
	"stddev":"std_deviation",
	"var":"variance",
	"variance":"variance"
};

//PROCESS RESULTS FROM THE ES STATISTICAL FACETS
ESQuery.prototype.statisticalResults = function(data){
	var cube;
	var agg=this.select.map(function(s){ return ESQuery.agg2es[s.aggregate];});
	var agg0=agg[0];
	var self=this;

	if (this.query.edges.length==0){ //ZERO DIMENSIONS
		if (this.select.length==0){
			cube = data.facets["0"][agg0];
		}else{
			cube={};
			for(var i=this.select.length;i--;){
				cube[this.select[i].name]= data.facets["0"][agg[i]];
			}//for
		}//endif
		this.query.cube = cube;
		return;
	}//endif

	//MAKE Qb
	cube = Qb.cube.newInstance(this.query.edges, 0, this.query.select);

	//FILL Qb
	if (self.query.select instanceof Array){
		forAllKey(data.facets, function(edgeName, facetValue){
			var coord = edgeName.split(",");
			var d = cube;
			var num=self.query.edges.length;
			for(var f = 0; f < num; f++){
				var offset=parseInt(coord[f]);
				d = d[offset];
			}//for
			for(var s=self.select.length;s--;){
				if (agg0!="count" && facetValue.count==0){
					d[self.select[s].name] = null;
				}else{
					d[self.select[s].name] = facetValue[agg[s]];
				}//endif
			}//for
		});
	}else{
		forAllKey(data.facets, function(edgeName, facetValue){
			var coord = edgeName.split(",");
			var d = cube;
			var num=self.query.edges.length - 1;
			for(var f = 0; f < num; f++){
				var offset=parseInt(coord[f]);
				d = d[offset];
			}//for
			if (agg0!="count" && facetValue.count==0){
				d[parseInt(coord[f])]=nvl(self.query.select["default"], null);
			}else{
				d[parseInt(coord[f])] = facetValue[agg0];
			}//endif
		});
	}//endif
	this.query.cube = cube;

};//method



//PROCESS THE RESULTS FROM THE ES TERMS_STATS FACETS
ESQuery.prototype.terms_statsResults = function(data){
//FIND ALL TERMS FOUND BY THE SPECIAL EDGE
	var partitions = [];
	var map = {};
	var keys = Object.keys(data.facets);
	for(var k = 0; k < keys.length; k++){
		var terms = data.facets[keys[k]].terms;
		for(var t = 0; t < terms.length; t++){
			var term = terms[t].term;
			if (map[term] === undefined){
				var part = {"value":term, "name":term};
				partitions.push(part);
				map[term] = part;
			}//endif
		}//for
	}//for
	partitions.sort(this.specialEdge.domain.compare);
	for(var p = 0; p < partitions.length; p++) partitions[p].dataIndex = p;
//	partitions[p]=this.specialEdge.domain.NULL;
//	partitions[p].dataIndex = p;

	this.specialEdge.domain.map = map;
	this.specialEdge.domain.partitions = partitions;


	//MAKE Qb
	var cube = Qb.cube.newInstance(this.query.edges, 0, this.query.select);

	//FILL Qb
	for(var k = 0; k < keys.length; k++){
		var edgeName = keys[k];
		var coord = edgeName.split(",");
		var terms = data.facets[edgeName].terms;
		for(var t = 0; t < terms.length; t++){
			var d = cube;
			var f = 0;
			var c = 0;
			for(; f < this.query.edges.length - 1; f++){
				if (this.query.edges[f] == this.specialEdge){
					d = d[this.specialEdge.domain.map[terms[t].term].dataIndex];
				} else{
					d = d[parseInt(coord[c])];
					c++;
				}//endif
			}//for
			var value = terms[t][ESQuery.agg2es[this.select[0].aggregate]];
			if (this.query.edges[f] == this.specialEdge){
				d[this.specialEdge.domain.map[terms[t].term].dataIndex] = value;
			} else{
				d[parseInt(coord[c])] = value;
			}//endif
		}//for
	}//for

	this.query.cube = cube;

};//method



ESQuery.prototype.compileSetOp=function(){
	var self=this;
	this.esQuery=this.buildESQuery();
	var select=Array.newInstance(this.query.select);

	var isDeep=self.query.from.split(".").length>1;

	//WE CAN OPTIMIZE WHEN ALL THE FIELDS ARE SIMPLE ENOUGH
	this.esMode = isDeep ? "setop": "fields";
	select.forall(function(s, i){
		if (!MVEL.isKeyword(s.value) || s.value.indexOf(".")>=0){
			self.esMode="setop";  //RETURN TO setop
		}//endif
	});


	if (this.esMode=="fields"){
		this.esQuery.size=200000;
		if (this.query.select.value!="_source"){
			this.esQuery.fields=select.map(function(s){return s.value;});
		}//endif
	}else if (!isDeep && select.length==1 && MVEL.isKeyword(select[0].value)){
		this.esQuery.facets.mvel={
			"terms":{
				"field": select[0].value,
				"size": this.query.essize
			}
		};
	}else{
		this.esQuery.facets.mvel={
			"terms":{
				"script_field": new MVEL().code(this.query),
				"size": this.query.essize
			}
		};
	}//endif
};



ESQuery.prototype.fieldsResults=function(data){
	var o = [];
	var T = data.hits.hits;

	if (this.query.select instanceof Array){
		for(var i = T.length; i--;){
		    var record=T[i].fields
			var new_rec={};
			this.query.select.forall(function(s, i){
				new_rec[s.name]=nvl(record[s.value], null);
			});
			o.push(new_rec)
		}//for
	}else{
		//NOT ARRAY MEANS OUTPUT IS LIST OF VALUES, NOT OBJECTS
		var n=this.query.select.name;
		if (this.query.select.value=="_source"){
			for(var i = T.length; i--;) o.push(T[i]._source);
		}else{
			for(var i = T.length; i--;) o.push(T[i].fields[n]);
		}//endif
	}//endif

	this.query.list=o;
};//method





ESQuery.prototype.mvelResults=function(data){
	var select=Array.newInstance(this.query.select);
	if (select.length==1 && MVEL.isKeyword(select[0].value)){
		//SPECIAL CASE FOR SINGLE TERM
		var T = data.facets.mvel.terms;
		var n=select[0].name;

		var output = [];
		for(var i = T.length; i--;) output.push(Map.newInstance(n, T[i].term));
		this.query.list= output;
	}else{
	 	this.query.list =  MVEL.esFacet2List(data.facets.mvel, this.select);
	}//endif


	select=this.query.select;
	if (select instanceof Array) return;
	//SELECT AS NO ARRAY (AND NO EDGES) MEANS A SIMPLE ARRAY OF VALUES, NOT AN ARRAY OF OBJECTS
	this.query.list=this.query.list.map(function(v, i){return v[select.name];});
};//method






var ESFilter={};

ESFilter.simplify=function(esfilter){

	return esfilter;

	//THIS DOES NOT WORK BECAUSE "[and] filter does not support [product]"
	//THIS DOES NOT WORK BECAUSE "[and] filter does not support [component]"
	//return ESFilter.removeOr(esfilter);

//THIS TAKES TOO LONG TO TRANSLATE ALL THE LOGIC FOR THOUSANDS OF FACETS
//	var normal=ESFilter.normalize(esfilter);
//	if (normal.or && normal.or.length==1) normal=normal.or[0];
//	var clean=CNV.JSON2Object(CNV.Object2JSON(normal).replaceAll('"isNormal":true,', '').replaceAll(',"isNormal":true', '').replaceAll('"isNormal":true', ''));
//
//	//REMOVE REDUNDANT FACTORS
//	//REMOVE false TERMS
//	return clean;
};

ESFilter.removeOr=function(esfilter){
	if (esfilter.not) return {"not":ESFilter.removeOr(esfilter.not)};

	if (esfilter.and){
		return {"and":esfilter.and.map(function(v, i){
			return ESFilter.removeOr(v);
		})};
	}//endif

	if (esfilter.or){  //CONVERT OR TO NOT.AND.NOT
		return {"not":{"and":esfilter.or.map(function(v, i){
			return {"not":ESFilter.removeOr(v)};
		})}};
	}//endif

	return esfilter;
};//method


//ENSURE NO ES-FORBIDDEN COMBINATIONS APPEAR (WHY?!?!?!?!?!  >:| )
//NORMALIZE BOOLEAN EXPRESSION TO OR.AND.NOT FORM
ESFilter.normalize=function(esfilter){
	if (esfilter.isNormal) return esfilter;

Log.note("from: "+CNV.Object2JSON(esfilter));
	var output=esfilter;

	while(output!=null){
		esfilter=output;
		output=null;

		if (esfilter.terms){									//TERMS -> OR.TERM
			var fieldname=Object.keys(esfilter.terms)[0];
			output={};
			output.or=esfilter.terms[fieldname].map(function(t, i){
				return {"and":[{"term":Map.newInstance(fieldname, t)}], "isNormal":true};
			});
		}else if (esfilter.not && esfilter.not.or){				//NOT.OR -> AND.NOT
			output={};
			output.and=esfilter.not.or.map(function(e, i){
				return ESFilter.normalize({"not":e});
			});
		}else if (esfilter.not && esfilter.not.and){			//NOT.AND
			output={};
			output.or=esfilter.not.and.map(function(e, i){
				return ESFilter.normalize({"not":e});
			});
		}else if (esfilter.not && esfilter.not.not){			//NOT.NOT
			output=ESFilter.normalize(esfilter.not.not);
		}else if (esfilter.not){
			if (esfilter.not.isNormal){
				esfilter.isNormal=true;
			}else{
				output={"not":ESFilter.normalize(esfilter.not)};
			}//endif
		}else if (esfilter.and){
			output={"and":[]};

			esfilter.and.forall(function(a, i){
				a=ESFilter.normalize(a);
				if (a.or && a.or.length==1) a=a.or[0];

				if (a.and){										//AND.AND
					output.and.appendArray(a.and);
				}else if (a.script && a.script.script=="true"){
					//DO NOTHING
				}else{
					output.and.push(a);
				}//endif
			});

			var mult=function(and, d){							//AND.OR
				if (and[d].or === undefined){
					if (d==and.length-1)
						return {"or":[{"and":[and[d]], "isNormal":true}]};
					var out=mult(and, d+1);
					for(var o=0;o<out.or.length;o++){
						out.or[o].and.prepend(and[d]);
					}//for
					return out;
				}//endif

				if (d==and.length-1){
					var or=and[d].or;
					for(var i=0;i<or.length;i++){
						if (!or[i].and) or[i]={"and":[or[i]], "isNormal":true};
					}//for
					return {"or":or};
				}//endif

				var child=mult(and, d+1);
				var or=[];
				for(var i=0;i<and[d].or.length;i++){
					for(var c=0;c<child.or.length;c++){
						var temp={"and":[], "isNormal":true};
						if (and[d].or[i].and){
							temp.and.appendArray(and[d].or[i].and);
						}else{
							temp.and.push(and[d].or[i]);
						}//endif
						temp.and.appendArray(child.or[c].and);
						or.push(temp);
					}//for
				}//for
				return {"or":or};
			};
			output=mult(output.and, 0);
			output.isNormal=true;
			esfilter=output;
			break;
		}else if (esfilter.or){
			output={"or":[]};
			esfilter.or.forall(function(o, i){
				var k=ESFilter.normalize(o);
				if (k.or){
					output.or.appendArray(k.or);
				}else{
					output.or.push(k);
				}//endif
			});
			esfilter=output;
			break;
		}//endif
	}//while
Log.note("  to: "+CNV.Object2JSON(esfilter));

	esfilter.isNormal=true;
	return esfilter;
};//method

ESFilter.simplify(
	{"and":[
		{"and":[
				{"term":{"product":"core"}},
				{"or":[
						{"prefix":{"component":"javascript"}},
						{"prefix":{"component":"nanojit"}}
					]}
			]},
		{"not":{"and":[
					{
						"isNormal":true,
						"term":{"product":"core"}
					},
					{"or":[
							{
								"isNormal":true,
								"prefix":{"component":"layout"}
							},
							{
								"isNormal":true,
								"prefix":{"component":"printing"}
							},
							{
								"isNormal":true,
								"prefix":{"component":"webrtc"}
							},
							{"terms":{"component":[
										"style system (css)",
										"svg",
										"video/audio",
										"internationalization"
									]}}
						]}
				]}}
	]}
);
