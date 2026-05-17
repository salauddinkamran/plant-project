import { FaUserCog, FaUsers } from "react-icons/fa";
import MenuItem from "./MenuItem";

const AdminMenu = () => {
  return (
    <>
      <MenuItem icon={FaUserCog} label="Manage Users" address="manage-users" />
      <MenuItem
        icon={FaUsers}
        label="Seller Requests"
        address="seller-requests"
      />
    </>
  );
};

export default AdminMenu;
