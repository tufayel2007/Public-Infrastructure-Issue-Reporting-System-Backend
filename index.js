const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");
const cors = require("cors");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const jwtSecret = process.env.JWT_SECRET;
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

let issues, users, payments;

async function connectDB() {
  const db = client.db("IssueHub");
  issues = db.collection("issues");
  payments = db.collection("payments");
  users = db.collection("users");
  console.log("✅ MongoDB Connected");
}
connectDB();
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

const verifyToken = async (req, res, next) => {
  console.log(req.user);
  const authHeader = req.headers.authorization;
  console.log("AUTH HEADER =", authHeader);

  if (!authHeader) {
    return res.status(401).json({ message: "Login Now !" });
  }

  const token = authHeader.split(" ")[1];
  console.log("TOKEN =", token);

  if (!token) {
    return res.status(401).json({ message: "Login Now!" });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    const user = await users.findOne({ _id: new ObjectId(decoded.userId) });
    if (user.blocked) {
      return res.status(403).json({
        message:
          "Your account is blocked. Contact authority. and Contact Admin or Staff ",
        blocked: true,
      });
    }
    // console.log("Decoded user:", decoded);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    req.user = {
      uid: user._id.toString(),
      name: user.name || user.email.split("@")[0],
      email: user.email,
      role: user.role || "citizen",
      subscription: user.subscription || "free",
      avatarUrl: user.photoURL || null,
    };

    next();
  } catch (err) {
    console.error("JWT ERROR:", err.message);
    return res.status(401).json({ message: "Session expired. Login again." });
  }
};
// ---------------------- Latest Updates (Public or Authenticated) ---------------------
app.get("/issues/resolved/latest", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 6;
    const data = await issues
      .find({ status: "resolved" })
      .sort({ date: -1 })
      .limit(limit)
      .toArray();

    res.send({ success: true, issues: data });
  } catch (err) {
    console.error(err);
    res.status(500).send({
      success: false,
      message: "Failed to fetch latest resolved issues",
    });
  }
});
// ---------------------- Create Issue (আপডেটেড) ----------------------
app.post("/issues", verifyToken, upload.single("image"), async (req, res) => {
  try {
    const { title, description, category, location } = req.body;
    let imageUrl = "";

    if (req.file) imageUrl = "/uploads/" + req.file.filename;
    if (req.user.subscription !== "premium") {
      const totalIssues = await issues.countDocuments({ uid: req.user.uid });

      if (totalIssues >= 3) {
        return res.status(403).json({
          message:
            "ফ্রি ইউজারের সর্বোচ্চ ৩টি রিপোর্টের লিমিট শেষ। প্রিমিয়াম নিন।",
          needPremium: true,
        });
      }
    }
    const issuePriority =
      req.user.subscription === "premium" ? "high" : "normal";
    const newIssue = {
      uid: req.user.uid,
      citizenName: req.user.name,
      title,
      description,
      category,
      location,
      status: "pending",
      priority: issuePriority,
      assignedStaff: null,
      upvotes: [],
      date: new Date(),
      imageUrl: imageUrl || "/placeholder.jpg",
      reactions: [],
      comments: [],
      timeline: [
        {
          status: "pending",
          message:
            issuePriority === "high"
              ? "Premium user issue (High Priority)"
              : "Issue reported by citizen",
          updatedBy: req.user.name,
          createdAt: new Date(),
        },
      ],
    };

    const result = await issues.insertOne(newIssue);
    res.send({ success: true, issue: { ...newIssue, _id: result.insertedId } });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to create issue" });
  }
});

app.post("/issues/:id/upvote", verifyToken, async (req, res) => {
  const issueId = req.params.id;
  const uid = req.user.uid;

  const issue = await issues.findOne({ _id: new ObjectId(issueId) });
  if (!issue) return res.status(404).send({ message: "Issue not found" });

  if (issue.uid === uid) {
    return res.status(400).send({ message: "Cannot upvote own issue" });
  }

  const alreadyUpvoted = issue.upvotes?.includes(uid);

  if (alreadyUpvoted) {
    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      { $pull: { upvotes: uid } }
    );
  } else {
    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      { $push: { upvotes: uid } }
    );
  }

  res.send({ success: true });
});

// ---------------------- Get Issues with pagination, filter, search ----------------------
// Get Issues with pagination, filter, search — using aggregation for priority sort
app.get("/issues", verifyToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8;

    const match = {};

    if (req.query.mine === "true") {
      match.uid = req.user.uid;
    }

    if (req.query.category && req.query.category !== "all")
      match.category = req.query.category;

    if (req.query.status && req.query.status !== "all")
      match.status = req.query.status;

    if (req.query.search)
      match.title = { $regex: req.query.search, $options: "i" };

    const pipeline = [
      { $match: match },
      {
        $addFields: {
          priorityRank: {
            $cond: [{ $eq: ["$priority", "high"] }, 1, 0],
          },
        },
      },
      { $sort: { priorityRank: -1, date: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    ];

    const data = await issues.aggregate(pipeline).toArray();
    const total = await issues.countDocuments(match);

    res.send({
      issues: data,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch issues" });
  }
});

// ---------------------- React to Issue (Single Reaction) ----------------------
app.post("/issues/:id/react", verifyToken, async (req, res) => {
  try {
    const { type } = req.body;
    const uid = req.user.uid;
    const issueId = req.params.id;

    const issue = await issues.findOne({ _id: new ObjectId(issueId) });
    if (!issue) return res.status(404).send({ message: "Issue not found" });

    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      { $pull: { reactions: { uid } } }
    );

    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      { $push: { reactions: { uid, type, date: new Date() } } }
    );

    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to react" });
  }
});
// citizen
app.post("/register/citizen", upload.single("photo"), async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res
        .status(400)
        .send({ success: false, message: "Missing fields" });

    const usersCollection = client.db("IssueHub").collection("users");

    const exists = await usersCollection.findOne({ email });
    if (exists) {
      return res.send({ success: false, message: "User already exists" });
    }

    const newUser = {
      name, // <-- Store name
      email,
      password,
      role: "citizen",
      photo: req.file ? `/uploads/${req.file.filename}` : null,
      createdAt: new Date(),
    };

    await usersCollection.insertOne(newUser);

    res.send({ success: true, message: "Citizen registered!", user: newUser });
  } catch (error) {
    console.log(error);
    res.status(500).send({ success: false, message: "Server error" });
  }
});

// server
app.get("/citizen/stats", verifyToken, async (req, res) => {
  const uid = req.user.uid;

  const [total, pending, inProgress, resolved] = await Promise.all([
    issues.countDocuments({ uid }),
    issues.countDocuments({ uid, status: "pending" }),
    issues.countDocuments({ uid, status: "in-progress" }),
    issues.countDocuments({ uid, status: "resolved" }),
  ]);

  res.send({ total, pending, inProgress, resolved });
});
const profileCollection = client
  .db("IssueHub")
  .collection("User_And_Admin_And_Staff_fProfile");

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
      return res.status(403).send({
        message:
          "This issue is currently in progress and cannot be edited at this time.",
      });
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

    // Admin can delete any issue
    if (req.user.role !== "admin" && issue.uid !== req.user.uid) {
      return res.status(403).send({ message: "Unauthorized" });
    }

    await issues.deleteOne({ _id: new ObjectId(issueId) });
    res.send({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Server error" });
  }
});

// admin panal and admin setup staart
// ###########################################

// Role Middleware
const verifyRole = (requiredRole) => {
  return (req, res, next) => {
    try {
      if (!req.user) return res.status(401).send({ message: "Unauthorized" });

      // Admin can access everything
      if (req.user.role === "admin") return next();

      if (requiredRole && req.user.role !== requiredRole) {
        return res.status(403).send({ message: "Forbidden - Not Authorized" });
      }

      next();
    } catch (err) {
      console.error("verifyRole error:", err);
      return res.status(500).send({ message: "Server error" });
    }
  };
};

// GET All Users (Admin Only)
app.get("/admin/users", verifyToken, verifyRole("admin"), async (req, res) => {
  try {
    const allUsers = await users.find().toArray();
    res.send(allUsers);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch users" });
  }
});
// Block User
app.patch(
  "/admin/user/block/:id",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid user id" });

      const result = await users.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { blocked: true } },
        { returnDocument: "after" }
      );

      if (!result.value)
        return res.status(404).send({ message: "User not found" });

      res.send({ success: true, user: result.value });
    } catch (err) {
      console.error(err);
      res.status(500).send({ message: "Failed to block user" });
    }
  }
);

// . Unblock User
app.patch(
  "/admin/user/unblock/:id",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid user id" });

      const result = await users.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: { blocked: false } },
        { returnDocument: "after" }
      );

      if (!result.value)
        return res.status(404).send({ message: "User not found" });

      res.send({ success: true, user: result.value });
    } catch (err) {
      console.error(err);
      res.status(500).send({ message: "Failed to unblock user" });
    }
  }
);

// Add Staff (Admin Only)
app.post("/admin/staff", verifyToken, verifyRole("admin"), async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!email || !password)
      return res.status(400).send({ message: "Email & Password required" });

    const exists = await users.findOne({ email });
    if (exists) return res.status(400).send({ message: "User already exists" });

    const newStaff = {
      name,
      email,
      phone,
      role: "staff",
      password,
      createdAt: new Date(),
      blocked: false,
    };

    const result = await users.insertOne(newStaff);

    res.send({ success: true, staffId: result.insertedId });
  } catch (err) {
    res.status(500).send({ message: "Failed to add staff" });
  }
});

// Update Staff
app.put(
  "/admin/staff/:id",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    const id = req.params.id;
    const { name, phone } = req.body;

    await users.updateOne({ _id: new ObjectId(id) }, { $set: { name, phone } });

    res.send({ success: true, message: "Staff updated" });
  }
);
// Delete Staff
app.delete(
  "/admin/staff/:id",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    const id = req.params.id;

    await users.deleteOne({ _id: new ObjectId(id) });

    res.send({ success: true, message: "Staff deleted" });
  }
);
// Get All Staff (Admin Only)
app.get(
  "/admin/staff/list",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    const staff = await users.find({ role: "staff" }).toArray();
    res.send(staff);
  }
);
// Stff asigne for solve issue
app.get(
  "/staff/issues/my-assigned",
  verifyToken,
  verifyRole("staff"),
  async (req, res) => {
    const staffId = req.user.uid;

    const assignedIssues = await issues
      .find({
        assignedStaff: { $ne: null },
        "assignedStaff.staffId": req.user.uid,
      })
      .toArray();

    res.send(assignedIssues);
  }
);

// Get All Issues (Admin
app.get("/admin/issues", verifyToken, verifyRole("admin"), async (req, res) => {
  const allIssues = await issues.find().sort({ date: -1 }).toArray();
  res.send(allIssues);
});
// Assign Staff to Issue
app.patch(
  "/admin/issue/assign/:id",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    const issueId = req.params.id;
    const { staffId, staffName } = req.body;

    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      {
        $set: {
          assignedStaff: { staffId, staffName },
          status: "in-progress",
        },
        $push: {
          timeline: {
            status: "Assigned",
            message: `Assigned to ${staffName}`,
            updatedBy: "Admin",
            date: new Date(),
          },
        },
      }
    );

    res.send({ success: true });
  }
);
// Reject Issue with Reason
app.patch(
  "/admin/issue/reject/:id",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    const issueId = req.params.id;
    const { reason } = req.body;

    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      {
        $set: {
          status: "rejected",
        },
        $push: {
          timeline: {
            status: "rejected",
            message: reason || "Issue rejected by admin",
            updatedBy: "Admin",
            date: new Date(),
          },
        },
      }
    );

    res.send({ success: true });
  }
);

// Get All Payments (Admin
app.get(
  "/admin/payments",
  verifyToken,
  verifyRole("admin"),
  async (req, res) => {
    const payments = await client
      .db("IssueHub")
      .collection("payments")
      .find()
      .sort({ date: -1 })
      .toArray();
    res.send(payments);
  }
);
// admin login

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const user = await users.findOne({ email });

  if (!user) return res.status(400).send({ message: "User not found" });

  if (user.password !== password)
    return res.status(400).send({ message: "Wrong password" });

  if (user.blocked)
    return res.status(403).send({ message: "This user is blocked" });

  const token = jwt.sign(
    { userId: user._id.toString(), email: user.email, role: user.role }, // Payload
    jwtSecret,
    { expiresIn: "7d" }
  );

  res.send({
    success: true,
    token,
    user: {
      _id: user._id,
      email: user.email,
      role: user.role,
      name: user.name,
      subscription: user.subscription || "free",
      avatarUrl: user.photo || null,
    },
  });
});

// staff
app.get("/staff/issues", verifyToken, verifyRole("staff"), async (req, res) => {
  const all = await issues
    .find({ "assignedStaff.staffId": req.user.uid })
    .sort({ date: -1 })
    .toArray();

  res.send(all);
});

// Staff issue update route
app.patch(
  "/staff/issue/:id/status",
  verifyToken,
  verifyRole("staff"),
  async (req, res) => {
    const { status, note } = req.body;

    await issues.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: { status },
        $push: {
          timeline: {
            status,
            message: note,
            updatedBy: req.user.name,
            date: new Date(),
          },
        },
      }
    );

    res.send({ success: true });
  }
);
// Citizen Registration Route
app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;

  if (!email || !password)
    return res.status(400).send({ message: "Email & Password required" });

  const exists = await users.findOne({ email });
  if (exists) return res.status(400).send({ message: "Email already used" });

  const newUser = {
    name,
    email,
    password,
    role: "citizen",
    blocked: false,
    createdAt: new Date(),
  };

  await users.insertOne(newUser);

  res.send({ success: true, message: "Account created successfully" });
});

//  ######################################## admin end
// Create Boost Payment Session
// ---------------------- Boost Payment ----------------------
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET);

// Boost Payment Session
app.post("/payment/boost/create-session", verifyToken, async (req, res) => {
  try {
    const { issueId } = req.body;

    if (!issueId) {
      return res.status(400).json({ message: "IssueId required" });
    }

    const isPremium = req.user.subscription === "premium";

    // ✅ price + currency logic
    const currency = isPremium ? "usd" : "bdt";
    const amount = isPremium ? 0.5 : 100; // 0.5 USD ≈ 50 BDT

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: isPremium
                ? "Issue Boost (Premium User - Discounted)"
                : "Issue Boost (Free User)",
            },
            unit_amount:
              currency === "usd"
                ? Math.round(amount * 100) // cents
                : amount * 100, // paisa
          },
          quantity: 1,
        },
      ],
      metadata: {
        issueId,
        uid: req.user.uid,
        type: "boost",
        amount,
        currency,
        userType: isPremium ? "premium" : "free",
      },
      success_url: `${process.env.CLIENT_URL}/boost/success?session_id={CHECKOUT_SESSION_ID}&issueId=${issueId}`,
      cancel_url: `${process.env.CLIENT_URL}/boost/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("STRIPE ERROR:", error);
    res.status(500).json({ message: "Stripe session failed" });
  }
});

// ---------------- Verify Payment (called from frontend boost-success) ----------------
app.post("/payment/verify", verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId)
      return res.status(400).send({ message: "sessionId required" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session) return res.status(400).send({ message: "Invalid session" });
    if (session.payment_status !== "paid") {
      return res.status(400).send({ message: "Payment not completed" });
    }

    const metadata = session.metadata || {};
    const issueId = metadata.issueId;
    const uid = metadata.uid || req.user.uid;
    const amount = parseFloat(metadata.amount || 0);

    // Update issue: set priority high + add timeline
    await issues.updateOne(
      { _id: new ObjectId(issueId) },
      {
        $set: { priority: "high" },
        $push: {
          timeline: {
            status: "priority-boosted",
            message: `Boosted via payment (session ${session.id})`,
            updatedBy: metadata.userName || req.user.name,
            date: new Date(),
          },
        },
      }
    );

    // Save payment record
    await client
      .db("IssueHub")
      .collection("payments")
      .insertOne({
        stripeSessionId: session.id,
        type: "boost",
        uid,
        issueId,
        amount,
        currency: session.currency || process.env.STRIPE_CURRENCY,
        status: "success",
        date: new Date(),
      });

    res.send({ success: true });
  } catch (err) {
    console.error("payment verify error:", err);
    res
      .status(500)
      .send({ message: "Verification failed", error: err.message });
  }
});
// ################################################# premium futer options
app.post("/payment/premium/create-session", verifyToken, async (req, res) => {
  try {
    if (req.user.subscription === "premium") {
      return res.status(400).json({ message: "Already premium" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: "bdt",
            product_data: {
              name: "প্রিমিয়াম সাবস্ক্রিপশন - আনলিমিটেড রিপোর্ট",
            },
            unit_amount: 1000 * 100,
          },
          quantity: 1,
        },
      ],
      metadata: {
        uid: req.user.uid,
        type: "premium",
      },
      success_url: `${process.env.CLIENT_URL}/citizen/premium/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/citizen/premium/cancel`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Payment session failed" });
  }
});
app.post("/payment/premium/verify", verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ message: "Payment not completed" });
    }

    if (session.metadata.uid !== req.user.uid) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    if (session.amount_total !== 1000 * 100) {
      return res.status(400).json({ message: "Invalid payment amount" });
    }

    await users.updateOne(
      { _id: new ObjectId(req.user.uid) },
      { $set: { subscription: "premium", premiumUntil: null } }
    );

    await client.db("IssueHub").collection("payments").insertOne({
      stripeSessionId: session.id,
      type: "premium",
      uid: req.user.uid,
      amount: 1000,
      currency: "bdt",
      status: "success",
      date: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Verification failed" });
  }
});
// #****************************************########################################
// ---------------------- Get Current User Profile (Only Own) ----------------------
// Update user profile (name + photo)

app.put(
  "/api/profile",
  verifyToken,
  upload.single("photo"),
  async (req, res) => {
    try {
      const { name } = req.body;
      const updateData = {};

      if (name) updateData.name = name;
      if (req.file) updateData.photo = `/uploads/${req.file.filename}`;

      const result = await users.findOneAndUpdate(
        { _id: new ObjectId(req.user.uid) },
        { $set: updateData },
        { returnDocument: "after" }
      );

      if (!result.value)
        return res.status(404).json({ message: "User not found" });

      res.json({
        success: true,
        user: {
          ...result.value,
          avatarUrl: result.value.photo || null, // 🔥 critical
          _id: result.value._id.toString(),
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Failed to update profile" });
    }
  }
);

// ---------------------- Start Server ----------------------
async function startServer() {
  try {
    await connectDB();
    app.listen(port, () =>
      console.log(`🚀 Server running on http://localhost:${port}`)
    );
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
  }
}

startServer();
