require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("plantDB");
    const plantsCollection = db.collection("plants");
    const orderCollection = db.collection("orders");
    const userCollection = db.collection("users");
    const sellerCollection = db.collection("sellerRequests");

    // Save a plant data i db
    app.post("/plants", async (req, res) => {
      const plantData = req.body;
      const result = await plantsCollection.insertOne(plantData);
      res.send(result);
    });
    // get all plants from db
    app.get("/plants", async (req, res) => {
      const result = await plantsCollection.find().toArray();
      res.send(result);
    });

    app.get("/plants/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await plantsCollection.findOne(query);
      res.send(result);
    });

    app.delete("/plants/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await plantsCollection.deleteOne(query);
      res.send(result);
    });

    // payment endpoint
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: paymentInfo?.quantity,
          },
        ],
        customer_email: paymentInfo?.customer?.email,
        mode: "payment",
        metadata: {
          plantId: paymentInfo?.plantId,
          customer: paymentInfo?.customer?.email,
        },
        success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.CLIENT_DOMAIN}/plant/${paymentInfo?.plantId}`,
      });
      res.send({ url: session.url });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const plant = await plantsCollection.findOne({
        _id: new ObjectId(session.metadata.plantId),
      });

      const order = await orderCollection.findOne({
        transationId: session.payment_intent,
      });
      if (session.status === "complete" && plant && !order) {
        const orderInfo = {
          plantId: session.metadata.plantId,
          transationId: session.payment_intent,
          customer: session.metadata.customer,
          status: "pending",
          seller: plant.seller,
          name: plant.name,
          category: plant.category,
          quantity: 1,
          price: session.amount_total / 100,
          image: plant.image,
        };
        const result = await orderCollection.insertOne(orderInfo);
        // update plant quantity
        await plantsCollection.updateOne(
          {
            _id: new ObjectId(session.metadata.plantId),
          },
          { $inc: { quantity: -1 } }
        );

        return res.send({
          transationId: session.payment_intent,
          orderId: result.insertedId,
        });
      }
      res.send({
        transationId: session.payment_intent,
        orderId: order._id,
      });
    });

    // get all order for a customer by email
    app.get("/my-orders", verifyJWT, async (req, res) => {
      const result = await orderCollection
        .find({ customer: req.tokenEmail })
        .toArray();
      res.send(result);
    });

    // get all order for a seller by email
    app.get("/manage-orders/:email", async (req, res) => {
      const email = req.params.email;
      const result = await orderCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // get all plants for a seller by email
    app.get("/my-inventory/:email", async (req, res) => {
      const email = req.params.email;
      const result = await plantsCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.created_at = new Date().toISOString();
      userData.last_loggedIn = new Date().toISOString();
      userData.role = "customer";

      const query = {
        email: userData.email,
      };
      const alreadyExists = await userCollection.findOne(query);
      console.log("User Already Exists --->", !!alreadyExists);
      if (alreadyExists) {
        console.log("Updating user info.....");
        const result = await userCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }
      console.log("Saving new user info.....");
      const result = await userCollection.insertOne(userData);
      res.send(result);
    });

    app.get("/user/role", verifyJWT, async (req, res) => {
      console.log(req.tokenEmail);
      const result = await userCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    app.post("/become-seller", verifyJWT, async (req, res) => {
      const email = req.tokenEmail;
      const alreadyExists = await sellerCollection.findOne({ email });
      if (alreadyExists)
        return res
          .status(409)
          .send({ message: "Already requested, wait koro." });
      const result = await sellerCollection.insertOne({ email });
      res.send(result);
    });

    // get all seller request for admin
    app.get("/seller-requests", verifyJWT, async (req, res) => {
      const result = await sellerCollection.find().toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
