"use strict";
const {PredictionsService}=require("./service");
const createPredictions=options=>new PredictionsService(options);
module.exports={createPredictions};
