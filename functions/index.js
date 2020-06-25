const moment = require('moment');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const request = require('request-promise');
const Base64 = require('js-base64').Base64;

admin.initializeApp(functions.config().firebase);
const firestore = admin.firestore();
const AUTHORIZATION = "Basic " + Base64.encode('AccountId:SecretKey');

const DATE_FORMAT = "YYYY-MM-DD[T]HH:mm:ss[Z]";

// firebase deploy --only functions

// DEVELOPING:

// export GOOGLE_APPLICATION_CREDENTIALS="path to your json file like uber-for-x-58779-firebase-adminsdk-vkrvn-56c58820cc.json"

// Test https:
// firebase emulators:start --only functions

// Test firestore:
// firebase functions:shell


// Test functions with valid json data, it means replace data in testData.json with your existing trips and drivers.
// updateOrderStatus(require('./testData.json').acceptOrder)
async function acceptOrder(change, context) {
    const beforeValue = change.before.data();
    const afterValue = change.after.data();

    const parsedBody = await createTrip(afterValue.driver.device_id, afterValue.pickup);

    if (parsedBody["trip_id"]) {
        const updatedAt = moment().format(DATE_FORMAT);
        return change.after.ref.set({
            updated_at: updatedAt,
            status: "PICKING_UP",
            trip_id: parsedBody["trip_id"]
        }, {merge: true});
    }
}

// updateOrderStatus(require('./testData.json').startRide)
async function startRide(change, context) {
    const beforeValue = change.before.data();
    const afterValue = change.after.data();

    await completeTrip(beforeValue.trip_id);
    const parsedBody = await createTrip(afterValue.driver.device_id, afterValue.dropoff);

    if (parsedBody["trip_id"]) {
        const updatedAt = moment().format(DATE_FORMAT);
        return change.after.ref.set({
            updated_at: updatedAt,
            status: "DROPPING_OFF",
            trip_id: parsedBody["trip_id"]
        }, {merge: true});
    }
}

// updateOrderStatus(require('./testData.json').rejectRide)
async function rejectRide(change, context) {
    const beforeValue = change.before.data();

    await completeTrip(beforeValue.trip_id);

    const updatedAt = moment().format(DATE_FORMAT);
    return change.after.ref.set({
        updated_at: updatedAt,
        trip_id: null,
        driver: null,
    }, {merge: true});
}

// updateOrderStatus(require('./testData.json').endRide)
async function endRide(change, context) {
    const beforeValue = change.before.data();

    await completeTrip(beforeValue.trip_id);

    const updatedAt = moment().format(DATE_FORMAT);
    return change.after.ref.set({
        updated_at: updatedAt,
    }, {merge: true});
}

async function createTrip(deviceId, coordinates) {
    try {
        const data = {};
        data["device_id"] = deviceId;
        data["destination"] = {
            radius: 100,
            geometry: {
                "type": "Point",
                "coordinates": [coordinates.longitude, coordinates.latitude]
            }
        };

        const parsedBody = await request({
            method: 'POST',
            uri: 'https://v3.api.hypertrack.com/trips/',
            headers: {
                'Authorization': AUTHORIZATION
            },
            body: data,
            json: true // Automatically stringifies the body to JSON
        });
        console.log("createTrip: " + JSON.stringify(parsedBody));
        console.log("createTrip:trip_id: " + parsedBody["trip_id"]);

        return parsedBody;
    } catch (err) {
        console.error(err.message);
        console.trace();
    }
}

async function completeTrip(tripId) {
    if (tripId) {
        try {
            const parsedBody = await request({
                method: 'POST',
                uri: `https://v3.api.hypertrack.com/trips/${tripId}/complete`,
                headers: {
                    'Authorization': AUTHORIZATION
                },
                body: null
            });
            console.log("completeTrip: " + JSON.stringify(parsedBody));

            return parsedBody;
        } catch (err) {
            console.error(err.message);
            console.trace();
        }
    }
}

exports.updateOrderStatus = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        console.log("before: " + JSON.stringify(change.before.data()));
        console.log("after: " + JSON.stringify(change.after.data()));
        const beforeStatus = change.before.data().status;
        const afterStatus = change.after.data().status;

        if (beforeStatus === "NEW" && afterStatus === "ACCEPTED") {
            await acceptOrder(change, context);
        } else if (beforeStatus === "REACHED_PICKUP" && afterStatus === "STARTED_RIDE") {
            await startRide(change, context);
        } else if (beforeStatus !== "COMPLETED" && afterStatus === "COMPLETED") {
            await endRide(change, context);
        } else if (beforeStatus !== "CANCELLED" && afterStatus === "CANCELLED") {
            await rejectRide(change, context);
        }
    });

// deleteOrder(require('./testData.json').deleteOrder)
exports.deleteOrder = functions.firestore
    .document('orders/{orderId}')
    .onDelete(async (snap, context) => {
        // Get an object representing the document prior to deletion
        const deletedValue = snap.data();
        await completeTrip(deletedValue.trip_id);
    });

// http://localhost:5001/<your project name e.g. uber-for-x-58779>/us-central1/onTripUpdate
exports.onTripUpdate = functions.https.onRequest(async (req, res) => {
    const data = JSON.parse(req.rawBody);
    console.log("onTripUpdate:data: " + JSON.stringify(data));
    for (let i = 0; i < data.length; i++) {
        const event = data[i];
        console.log("onTripUpdate:event: " + JSON.stringify(event));
        if (event.type === "trip" && event.data.value === "destination_arrival") {
            let ordersRef = firestore.collection("orders");

            let querySnapshot = await ordersRef.where("trip_id", "==", event.data.trip_id).limit(1).get();
            let status, doc_id;
            querySnapshot.forEach((doc) => {
                doc_id = doc.id;
                console.log("onTripUpdate:doc.data: " + doc.id + " - " + JSON.stringify(doc.data()));
                if (doc.data().status === "PICKING_UP") {
                    status = "REACHED_PICKUP";
                } else if (doc.data().status === "DROPPING_OFF") {
                    status = "REACHED_DROPOFF";
                }
            });
            console.log("onTripUpdate:status: " + status);

            if (status) {
                await ordersRef.doc(doc_id).update({
                    status: status
                });
            }
        }
    }
    // Redirect with 303 SEE OTHER to the URL of the pushed object in the Firebase console.
    res.send("I ♥ HyperTrack");
});
