const Address = require("../models/Address");
const {
  validatePhysicalAddressForSave,
  shouldRunFullAddressValidation
} = require("../utils/addressValidation");

const clean = (val) => (typeof val === "string" ? val.trim() : val);

// Add a new address
const addAddress = async (req, res) => {
  try {
    const userId = req.userId;

    const {
      addressType,
      isDefault: isDefaultRaw,
      isGift,
      deliveryInstructions
    } = req.body;

    const candidate = {
      fullName: clean(req.body.fullName),
      phone: clean(req.body.phone),
      houseNumber: clean(req.body.houseNumber),
      building: clean(req.body.building),
      floor: clean(req.body.floor),
      area: clean(req.body.area),
      landmark: clean(req.body.landmark),
      addressLine1: clean(req.body.addressLine1),
      addressLine2: clean(req.body.addressLine2),
      city: clean(req.body.city),
      state: clean(req.body.state),
      postalCode: clean(req.body.postalCode),
      country: clean(req.body.country) || "India"
    };

    const validation = validatePhysicalAddressForSave(candidate);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        code: validation.code,
        message: validation.message,
        errors: validation.errors
      });
    }

    const d = validation.data;

    // =========================
    // 🔍 DUPLICATE CHECK (SMART)
    // =========================
    const existingAddress = await Address.findOne({
      userId,
      fullName: d.fullName,
      phone: d.phone,
      houseNumber: d.houseNumber,
      area: d.area,
      city: d.city,
      state: d.state,
      postalCode: d.postalCode
    });

    if (existingAddress) {
      return res.status(200).json({
        success: true,
        message: "Address already exists",
        address: existingAddress
      });
    }

    // =========================
    // 🔒 DEFAULT ADDRESS LOGIC
    // =========================
    const addressCount = await Address.countDocuments({ userId });

    let isDefault = false;
    if (addressCount === 0) {
      isDefault = true;
    } else if (isDefaultRaw === true || isDefaultRaw === "true") {
      await Address.updateMany({ userId }, { $set: { isDefault: false } });
      isDefault = true;
    }

    // =========================
    // 🏠 CREATE ADDRESS
    // =========================
    const address = new Address({
      userId,
      fullName: d.fullName,
      phone: d.phone,
      houseNumber: d.houseNumber,
      building: d.building || "",
      floor: d.floor || "",
      area: d.area,
      landmark: d.landmark || "",
      addressLine1: d.addressLine1,
      addressLine2: d.addressLine2,
      city: d.city,
      state: d.state,
      postalCode: d.postalCode,
      country: d.country,
      addressType: addressType || "home",
      isDefault,
      isGift: Boolean(isGift),
      deliveryInstructions: clean(deliveryInstructions) || ""
    });

    await address.save();

    return res.status(201).json({
      success: true,
      message: "Address added successfully",
      address
    });
  } catch (error) {
    console.error("Add address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error adding address",
      error: error.message
    });
  }
};


// Get all addresses for a user (PRO VERSION)
const getAddresses = async (req, res) => {
  try {
    const userId = req.userId;

    // =========================
    // 📦 FETCH ADDRESSES
    // =========================
    const addresses = await Address.find({ userId })
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();

    // =========================
    // 🎯 FIND DEFAULT ADDRESS
    // =========================
    let defaultAddress = null;

    if (addresses.length > 0) {
      defaultAddress = addresses.find(addr => addr.isDefault) || null;
    }

    // =========================
    // 🧹 REMOVE DEFAULT FROM LIST (optional clean UX)
    // =========================
    const otherAddresses = addresses.filter(addr => !addr.isDefault);

    // =========================
    // 📊 RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      count: addresses.length,
      defaultAddress,
      addresses: otherAddresses
    });

  } catch (error) {
    console.error("Get addresses error:", error);

    return res.status(500).json({
      success: false,
      message: "Error fetching addresses",
      error: error.message
    });
  }
};



// Update an address
const updateAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    const updates = { ...req.body };
    delete updates._id;
    delete updates.userId;

    const address = await Address.findOne({ _id: id, userId });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found"
      });
    }

    if (updates.phone) {
      updates.phone = clean(updates.phone);
    }
    if (updates.postalCode) {
      updates.postalCode = clean(updates.postalCode);
    }
    if (updates.fullName) {
      updates.fullName = clean(updates.fullName);
    }
    if (updates.houseNumber) {
      updates.houseNumber = clean(updates.houseNumber);
    }
    if (updates.building !== undefined) {
      updates.building = clean(updates.building);
    }
    if (updates.floor !== undefined) {
      updates.floor = clean(updates.floor);
    }
    if (updates.area) {
      updates.area = clean(updates.area);
    }
    if (updates.city) {
      updates.city = clean(updates.city);
    }
    if (updates.state) {
      updates.state = clean(updates.state);
    }
    if (updates.addressLine1) {
      updates.addressLine1 = clean(updates.addressLine1);
    }
    if (updates.addressLine2) {
      updates.addressLine2 = clean(updates.addressLine2);
    }
    if (updates.landmark !== undefined) {
      updates.landmark = clean(updates.landmark);
    }
    if (updates.country) {
      updates.country = clean(updates.country);
    }
    if (updates.deliveryInstructions !== undefined) {
      updates.deliveryInstructions = clean(updates.deliveryInstructions);
    }

    if (updates.isDefault === true || updates.isDefault === "true") {
      await Address.updateMany({ userId }, { $set: { isDefault: false } });
      updates.isDefault = true;
    }

    const updateKeys = Object.keys(updates).filter((k) => updates[k] !== undefined);
    const runFullValidation = shouldRunFullAddressValidation(updateKeys);

    if (runFullValidation) {
      const docObj = address.toObject();
      const merged = { ...docObj, ...updates };
      const validation = validatePhysicalAddressForSave(merged);
      if (!validation.ok) {
        return res.status(400).json({
          success: false,
          code: validation.code,
          message: validation.message,
          errors: validation.errors
        });
      }
      const { data: v } = validation;
      const validatedKeySet = new Set(Object.keys(v));
      for (const key of Object.keys(updates)) {
        if (validatedKeySet.has(key)) {
          address[key] = v[key];
        } else {
          address[key] = updates[key];
        }
      }
    } else {
      const requiredFields = [
        "fullName",
        "phone",
        "houseNumber",
        "area",
        "city",
        "state",
        "postalCode"
      ];
      for (const field of requiredFields) {
        if (updates[field] !== undefined && updates[field] === "") {
          return res.status(400).json({
            success: false,
            code: "FIELD_EMPTY",
            message: `${field} cannot be empty`
          });
        }
      }
      Object.keys(updates).forEach((key) => {
        address[key] = updates[key];
      });
    }

    await address.save();

    return res.status(200).json({
      success: true,
      message: "Address updated successfully",
      address
    });
  } catch (error) {
    console.error("Update address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error updating address",
      error: error.message
    });
  }
};


// Delete an address (PRO VERSION)
const deleteAddress = async (req, res) => {
  try {
    const userId = req.userId;
    const { id } = req.params;

    // =========================
    // 🔒 FIND ADDRESS (OWNERSHIP CHECK)
    // =========================
    const address = await Address.findOne({ _id: id, userId });

    if (!address) {
      return res.status(404).json({
        success: false,
        message: "Address not found"
      });
    }

    const isDefault = address.isDefault;

    // =========================
    // 🗑️ DELETE ADDRESS
    // =========================
    await Address.deleteOne({ _id: id, userId });

    // =========================
    // 🔁 DEFAULT FALLBACK LOGIC
    // =========================
    if (isDefault) {
      const nextAddress = await Address.findOne({ userId })
        .sort({ createdAt: -1 });

      if (nextAddress) {
        nextAddress.isDefault = true;
        await nextAddress.save();
      }
    }

    // =========================
    // 📊 RESPONSE
    // =========================
    return res.status(200).json({
      success: true,
      message: "Address deleted successfully"
    });

  } catch (error) {
    console.error("Delete address error:", error);

    return res.status(500).json({
      success: false,
      message: "Error deleting address",
      error: error.message
    });
  }
};


module.exports = { addAddress, getAddresses, updateAddress, deleteAddress };
