// index.js
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// MongoDB connection
const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: { version: "1", strict: true, deprecationErrors: true },
});

let issues, users;

async function connectDB() {
  await client.connect();
  const db = client.db("IssueHub");
  issues = db.collection("issues");
  users = db.collection("users");
  console.log("✅ MongoDB Connected");
}
connectDB();

// Fake auth middleware
const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized" });
  req.user = {
    uid: "demo-user-id",
    email: "demo@example.com",
    name: "Tufayel",
    avatarUrl: "/uploads/demo-avatar.png",
  };
  next();
};

// Multer setup for image upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ---------------------- Create Issue ----------------------
app.post("/issues", verifyToken, upload.single("image"), async (req, res) => {
  try {
    const { title, description, category, location } = req.body;
    let imageUrl = "";

    if (req.file) imageUrl = "/uploads/" + req.file.filename;

    const newIssue = {
      uid: req.user.uid,
      title,
      description,
      category,
      location,
      status: "pending",
      date: new Date(),
      imageUrl,
      reactions: [],
      comments: [],
    };

    await issues.insertOne(newIssue);
    res.send({ success: true, issue: newIssue });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to create issue" });
  }
});

// ---------------------- Get Issues with pagination, filter, search ----------------------
app.get("/issues", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8;
    const query = {};

    if (req.query.category && req.query.category !== "all")
      query.category = req.query.category;
    if (req.query.status && req.query.status !== "all")
      query.status = req.query.status;
    if (req.query.search)
      query.title = { $regex: req.query.search, $options: "i" };

    const total = await issues.countDocuments(query);
    const totalPages = Math.ceil(total / limit);

    const data = await issues
      .find(query)
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    res.send({ issues: data, totalPages });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch issues" });
  }
});

// ---------------------- React to Issue ----------------------
app.post("/issues/:id/react", verifyToken, async (req, res) => {
  try {
    const { type } = req.body;
    const uid = req.user.uid;
    const issueId = req.params.id;

    const issue = await issues.findOne({ _id: new ObjectId(issueId) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });

    const existing = issue.reactions.find((r) => r.uid === uid);
    if (existing) {
      await issues.updateOne(
        { _id: new ObjectId(issueId) },
        { $pull: { reactions: { uid } } }
      );
    } else {
      await issues.updateOne(
        { _id: new ObjectId(issueId) },
        { $push: { reactions: { uid, type, date: new Date() } } }
      );
    }

    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to react" });
  }
});

// ---------------------- Comment on Issue ----------------------
app.post("/issues/:id/comment", verifyToken, async (req, res) => {
  try {
    const { text } = req.body;
    const uid = req.user.uid;
    const issueId = req.params.id;

    if (!text)
      return res.status(400).send({ message: "Comment cannot be empty" });

    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      {
        $push: {
          comments: {
            uid,
            text,
            date: new Date(),
            name: req.user.name,
            avatarUrl: req.user.avatarUrl,
          },
        },
      }
    );

    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to comment" });
  }
});
// ###############################################
// Get single issue
app.get("/issues/:id", verifyToken, async (req, res) => {
  try {
    const issueId = req.params.id;
    const issue = await issues.findOne({ _id: new ObjectId(issueId) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });
    res.send(issue);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Server error" });
  }
});

// Edit issue (only pending + own issue)
app.put("/issues/:id", verifyToken, async (req, res) => {
  try {
    const issueId = req.params.id;
    const issue = await issues.findOne({ _id: new ObjectId(issueId) });

    if (!issue) return res.status(404).send({ message: "Issue not found" });
    if (issue.uid !== req.user.uid)
      return res.status(403).send({ message: "Unauthorized" });
    if (issue.status !== "pending")
      return res
        .status(400)
        .send({ message: "Cannot edit resolved/in-progress issue" });

    const { title, description, category, location } = req.body;

    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      {
        $set: { title, description, category, location },
        $push: {
          timeline: {
            status: issue.status,
            message: "Issue edited",
            updatedBy: req.user.name,
            date: new Date(),
          },
        },
      }
    );

    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Server error" });
  }
});

// Delete issue (only pending + own issue)
app.delete("/issues/:id", verifyToken, async (req, res) => {
  try {
    const issueId = req.params.id;
    const issue = await issues.findOne({ _id: new ObjectId(issueId) });

    if (!issue) return res.status(404).send({ message: "Issue not found" });
    if (issue.uid !== req.user.uid)
      return res.status(403).send({ message: "Unauthorized" });
    if (issue.status !== "pending")
      return res
        .status(400)
        .send({ message: "Cannot delete resolved/in-progress issue" });

    await issues.deleteOne({ _id: new ObjectId(issueId) });
    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Server error" });
  }
});

// ---------------------- Start Server ----------------------
app.listen(port, () =>
  console.log(`🚀 Server running on http://localhost:${port}`)
);
